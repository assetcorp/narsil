mod payload;
mod release;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use narsil::Value;

use self::payload::{HandoffAction, LeadHandoff, encoded_answer, read_lead_handoff};
use super::PrimaryWrites;
use super::partition::{LeadHold, Partition};
use crate::allocator::Assignment;
use crate::controller::lock;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{TransportMessage, refusal};
use crate::payload::term_start::HeldEnd;

static NEXT_LEAD_HOLD: AtomicU64 = AtomicU64::new(1);

const LIFTED: HeldEnd = HeldEnd {
    last_seq_no: 0,
    last_primary_term: 0,
};

enum Claim {
    Extended(HeldEnd),
    Started(u64),
}

fn refused(handoff: &LeadHandoff, node_id: &str, reason: &str) -> ClusterError {
    ClusterError::new(
        codes::ALLOCATION_FAILED,
        format!(
            "Node '{node_id}' cannot hand the lead of partition {} of index '{}' to node '{}', because {reason}",
            handoff.partition_id, handoff.index_name, handoff.target
        ),
    )
    .with_detail("indexName", Value::from(handoff.index_name.as_str()))
    .with_detail("partitionId", Value::from(handoff.partition_id))
    .with_detail("primaryTerm", Value::Number(handoff.primary_term as f64))
    .with_detail("targetNodeId", Value::from(handoff.target.as_str()))
}

fn refusal_reason(
    assignment: Option<&Assignment>,
    handoff: &LeadHandoff,
    node_id: &str,
) -> Option<&'static str> {
    let Some(assignment) = assignment else {
        return Some("its allocation table holds no such partition");
    };
    if !assignment.is_primary(node_id) || assignment.primary_term as u64 != handoff.primary_term {
        return Some("its allocation table no longer gives it the lead under that term");
    }
    if !assignment.holds_in_sync(&handoff.target) {
        return Some("the target is outside its in-sync set");
    }
    None
}

impl PrimaryWrites {
    pub(crate) async fn answer_lead_handoff(
        self: &Arc<Self>,
        message: &TransportMessage,
    ) -> TransportMessage {
        let answered = match read_lead_handoff(message) {
            Ok(handoff) => match handoff.action {
                HandoffAction::Block => self
                    .block_for_handoff(&handoff)
                    .await
                    .map(|end| (handoff.partition_id, end)),
                HandoffAction::Lift => {
                    self.lift_handoff(&handoff);
                    Ok((handoff.partition_id, LIFTED))
                }
            },
            Err(error) => Err(error),
        };
        match answered {
            Ok((partition_id, end)) => TransportMessage::new(
                message.message_type.as_str(),
                self.node_id.as_str(),
                message.request_id.as_str(),
                encoded_answer(partition_id, end),
            ),
            Err(error) => refusal(message, &self.node_id, &error),
        }
    }

    fn lift_handoff(&self, handoff: &LeadHandoff) {
        let Some(partition) = self
            .partitions
            .existing(&handoff.index_name, handoff.partition_id)
        else {
            return;
        };
        let number = lock(&partition.lead_hold)
            .as_ref()
            .filter(|hold| {
                hold.primary_term == handoff.primary_term && hold.target == handoff.target
            })
            .map(|hold| hold.number);
        if let Some(number) = number {
            partition.end_lead_hold(number);
        }
    }

    async fn block_for_handoff(self: &Arc<Self>, handoff: &LeadHandoff) -> ClusterResult<HeldEnd> {
        let mut shutting_down = self.shutting_down.subscribe();
        let stopped = || refused(handoff, &self.node_id, "the node is shutting down");
        let table = tokio::select! {
            biased;
            _ = shutting_down.wait_for(|stopping| *stopping) => return Err(stopped()),
            table = self.view.refresh(&handoff.index_name) => table?,
        };
        let assignment = table
            .as_ref()
            .and_then(|table| table.assignments.get(f64::from(handoff.partition_id)));
        if let Some(reason) = refusal_reason(assignment, handoff, &self.node_id) {
            return Err(refused(handoff, &self.node_id, reason));
        }
        let partition = self
            .partitions
            .of(&handoff.index_name, handoff.partition_id);
        let hold_for = self.replication_timeout();
        let number = match self.claim_lead_hold(&partition, handoff, hold_for)? {
            Claim::Extended(end) => return Ok(end),
            Claim::Started(number) => number,
        };
        let confirmed = tokio::select! {
            biased;
            _ = shutting_down.wait_for(|stopping| *stopping) => Err(stopped()),
            confirmed = self.confirm_handoff_target(&partition, handoff, number, hold_for) => confirmed,
        };
        if confirmed.is_err() {
            partition.end_lead_hold(number);
        }
        confirmed
    }

    fn claim_lead_hold(
        &self,
        partition: &Partition,
        handoff: &LeadHandoff,
        hold_for: Duration,
    ) -> ClusterResult<Claim> {
        let mut hold = lock(&partition.lead_hold);
        if let Some(held) = hold.as_mut()
            && held.primary_term >= handoff.primary_term
            && (held.held.is_some() || Instant::now() < held.deadline)
        {
            let same = held.primary_term == handoff.primary_term && held.target == handoff.target;
            if same && let Some(end) = held.held {
                held.deadline = Instant::now() + hold_for;
                drop(hold);
                partition.signal_lead_hold_change();
                return Ok(Claim::Extended(end));
            }
            return Err(refused(
                handoff,
                &self.node_id,
                "it is handing over the lead of that partition already",
            ));
        }
        let number = NEXT_LEAD_HOLD.fetch_add(1, Ordering::Relaxed);
        *hold = Some(LeadHold {
            primary_term: handoff.primary_term,
            target: handoff.target.clone(),
            number,
            deadline: Instant::now() + hold_for,
            held: None,
        });
        drop(hold);
        partition.signal_lead_hold_change();
        Ok(Claim::Started(number))
    }

    fn hold_is_current(
        &self,
        partition: &Partition,
        number: u64,
        update: impl FnOnce(&mut LeadHold),
    ) -> bool {
        let mut hold = lock(&partition.lead_hold);
        match hold.as_mut() {
            Some(held) if held.number == number => {
                update(held);
                true
            }
            _ => false,
        }
    }

    async fn confirm_handoff_target(
        self: &Arc<Self>,
        partition: &Arc<Partition>,
        handoff: &LeadHandoff,
        number: u64,
        hold_for: Duration,
    ) -> ClusterResult<HeldEnd> {
        let lifted = || refused(handoff, &self.node_id, "the controller lifted the handover");
        let Ok(mut turn) = tokio::time::timeout(hold_for, partition.turn()).await else {
            return Err(refused(
                handoff,
                &self.node_id,
                "its write queue stayed busy for the whole handover",
            ));
        };
        let deadline = Instant::now() + hold_for;
        if !self.hold_is_current(partition, number, |held| held.deadline = deadline) {
            return Err(lifted());
        }
        let mut changes = partition.lead_hold_changes.subscribe();
        let confirming = async {
            let scope = self
                .current_scope(partition, &handoff.index_name, handoff.partition_id)
                .await
                .map_err(|error| refused(handoff, &self.node_id, error.message()))?;
            if let Some(reason) = refusal_reason(Some(&scope.assignment), handoff, &self.node_id) {
                return Err(refused(handoff, &self.node_id, reason));
            }
            Ok(self.bring_copy_to_end(&scope, &handoff.target).await)
        };
        let lifted_while_confirming = async {
            while partition.lead_hold_deadline(number).is_some() {
                if changes.changed().await.is_err() {
                    break;
                }
            }
        };
        let confirmed = tokio::select! {
            confirmed = tokio::time::timeout_at(deadline.into(), confirming) => confirmed,
            () = lifted_while_confirming => return Err(lifted()),
        };
        let end = confirmed.ok().transpose()?.flatten();
        let Some(end) = end else {
            return Err(refused(
                handoff,
                &self.node_id,
                "the target did not confirm that it holds every entry of this copy",
            ));
        };
        if !self.hold_is_current(partition, number, |held| held.held = Some(end)) {
            return Err(lifted());
        }
        let (writes, held_partition) = (Arc::clone(self), Arc::clone(partition));
        let (index_name, partition_id) = (handoff.index_name.clone(), handoff.partition_id);
        let primary_term = handoff.primary_term;
        turn.hold_through(async move {
            writes
                .hold_until_released(
                    held_partition,
                    index_name,
                    partition_id,
                    primary_term,
                    number,
                )
                .await;
        });
        Ok(end)
    }
}
