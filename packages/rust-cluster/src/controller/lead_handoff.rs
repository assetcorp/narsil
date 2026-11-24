use std::sync::Arc;
use std::time::Duration;

use narsil::{Map, Value};
use tokio::task::JoinSet;

use super::Inner;
use crate::allocator::{ACTIVE, Table, is_draining};
use crate::coordinator::NodeRegistration;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::message_types;
use crate::rebalance::{RebalanceExchange, exchange_rebalance_message};
use crate::transport::NodeTransport;

const BLOCK: &str = "block";
const LIFT: &str = "lift";

#[derive(Debug, Clone, PartialEq)]
pub(super) struct LeadMove {
    partition_id: f64,
    primary: String,
    target: String,
    primary_term: f64,
    draining: bool,
}

pub(super) type HeldHandoffs = Vec<LeadMove>;

struct HandoffSend {
    transport: Arc<dyn NodeTransport>,
    sender_id: String,
    index_name: String,
    targets: Vec<String>,
    wait: Duration,
}

fn lead_moves(stored: &Table, next: &Table, nodes: &[NodeRegistration]) -> Vec<LeadMove> {
    let mut moves = Vec::new();
    for (partition_id, before) in stored.assignments.iter() {
        let Some(after) = next.assignments.get(partition_id) else {
            continue;
        };
        let (Some(primary), Some(target)) = (before.primary.as_deref(), after.primary.as_deref())
        else {
            continue;
        };
        if primary == target
            || before.state != ACTIVE
            || after.state != ACTIVE
            || !before.holds_in_sync(target)
        {
            continue;
        }
        let Some(node) = nodes.iter().find(|node| node.node_id == primary) else {
            continue;
        };
        moves.push(LeadMove {
            partition_id,
            primary: primary.to_string(),
            target: target.to_string(),
            primary_term: before.primary_term,
            draining: is_draining(node),
        });
    }
    moves
}

fn keep_lead(next: &mut Table, lead_move: &LeadMove) {
    let Some(assignment) = next.assignments.get_mut(lead_move.partition_id) else {
        return;
    };
    assignment.primary = Some(lead_move.primary.clone());
    assignment.primary_term = lead_move.primary_term;
    for members in [&mut assignment.replicas, &mut assignment.in_sync_set] {
        let position = members.iter().position(|id| *id == lead_move.primary);
        if members.contains(&lead_move.target) {
            members.retain(|id| *id != lead_move.primary);
        } else if let Some(at) = position {
            members[at] = lead_move.target.clone();
        } else {
            members.push(lead_move.target.clone());
        }
    }
}

fn targets_of(nodes: &[NodeRegistration], node_id: &str) -> Vec<String> {
    let address = nodes
        .iter()
        .find(|node| node.node_id == node_id)
        .map(|node| node.address.as_str());
    match address {
        Some(address) if !address.is_empty() && address != node_id => {
            vec![node_id.to_string(), address.to_string()]
        }
        _ => vec![node_id.to_string()],
    }
}

fn unanswered(send: &HandoffSend, lead_move: &LeadMove, action: &str) -> ClusterError {
    ClusterError::new(
        codes::ALLOCATION_FAILED,
        format!(
            "Node '{}' did not answer the lead handover {action} of partition {} of index '{}' within {} ms",
            lead_move.primary,
            lead_move.partition_id,
            send.index_name,
            send.wait.as_millis()
        ),
    )
    .with_detail("indexName", Value::String(send.index_name.clone()))
    .with_detail("partitionId", Value::Number(lead_move.partition_id))
    .with_detail("primaryNodeId", Value::String(lead_move.primary.clone()))
}

async fn send_handoff(send: HandoffSend, lead_move: LeadMove, action: &'static str) -> bool {
    let mut payload = Map::with_capacity(5);
    payload.insert("indexName", Value::String(send.index_name.clone()));
    payload.insert("partitionId", Value::Number(lead_move.partition_id));
    payload.insert("primaryTerm", Value::Number(lead_move.primary_term));
    payload.insert("targetNodeId", Value::String(lead_move.target.clone()));
    payload.insert("action", Value::String(action.to_string()));
    let mut details = Map::with_capacity(3);
    details.insert("indexName", Value::String(send.index_name.clone()));
    details.insert("partitionId", Value::Number(lead_move.partition_id));
    details.insert("primaryNodeId", Value::String(lead_move.primary.clone()));
    let exchange = exchange_rebalance_message(RebalanceExchange {
        transport: send.transport.as_ref(),
        sender_id: &send.sender_id,
        targets: send.targets.clone(),
        message_type: message_types::CLUSTER_LEAD_HANDOFF,
        payload: Value::Object(payload),
        failure_message: unanswered(&send, &lead_move, action).message().to_string(),
        details,
    });
    let answered: ClusterResult<Map> = match tokio::time::timeout(send.wait, exchange).await {
        Ok(answered) => answered,
        Err(_) => Err(unanswered(&send, &lead_move, action)),
    };
    answered.is_ok_and(|answer| {
        let (Some(Value::Number(partition)), Some(Value::Number(last)), Some(Value::Number(term))) = (
            answer.get("partitionId"),
            answer.get("lastSeqNo"),
            answer.get("lastPrimaryTerm"),
        ) else {
            return false;
        };
        *partition == lead_move.partition_id
            && last.is_finite()
            && last.fract() == 0.0
            && *last >= 0.0
            && term.is_finite()
            && term.fract() == 0.0
            && *term >= 0.0
            && *term <= lead_move.primary_term
            && (*last == 0.0) == (*term == 0.0)
    })
}

impl Inner {
    fn handoff_send(
        &self,
        index_name: &str,
        nodes: &[NodeRegistration],
        primary: &str,
    ) -> HandoffSend {
        HandoffSend {
            transport: Arc::clone(&self.config.transport),
            sender_id: self.node_id().to_string(),
            index_name: index_name.to_string(),
            targets: targets_of(nodes, primary),
            wait: self.config.transport.timeouts().replication_timeout / 2,
        }
    }

    async fn send_handoffs(
        &self,
        index_name: &str,
        nodes: &[NodeRegistration],
        moves: &[LeadMove],
        action: &'static str,
    ) -> Vec<(LeadMove, bool)> {
        let mut sending = JoinSet::new();
        for lead_move in moves {
            let send = self.handoff_send(index_name, nodes, &lead_move.primary);
            let lead_move = lead_move.clone();
            sending.spawn(async move {
                let answered = send_handoff(send, lead_move.clone(), action).await;
                (lead_move, answered)
            });
        }
        let mut outcomes = Vec::with_capacity(moves.len());
        while let Some(joined) = sending.join_next().await {
            if let Ok(outcome) = joined {
                outcomes.push(outcome);
            }
        }
        outcomes
    }

    pub(super) async fn lift_handoffs(
        &self,
        index_name: &str,
        nodes: &[NodeRegistration],
        moves: &[LeadMove],
    ) {
        if !moves.is_empty() {
            self.send_handoffs(index_name, nodes, moves, LIFT).await;
        }
    }

    pub(super) async fn hand_over_leads(
        &self,
        index_name: &str,
        stored: Option<&Table>,
        mut next: Table,
        nodes: &[NodeRegistration],
        held: &mut HeldHandoffs,
    ) -> Table {
        let moves = stored.map_or_else(Vec::new, |stored| lead_moves(stored, &next, nodes));
        let stale: Vec<LeadMove> = held
            .drain(..)
            .filter(|lead_move| !moves.contains(lead_move))
            .collect();
        self.lift_handoffs(index_name, nodes, &stale).await;
        let mut failed = Vec::new();
        for (lead_move, answered) in self.send_handoffs(index_name, nodes, &moves, BLOCK).await {
            if answered {
                held.push(lead_move);
            } else {
                failed.push(lead_move);
            }
        }
        let answered: Vec<&LeadMove> = held.iter().collect();
        for lead_move in moves
            .iter()
            .filter(|lead_move| !answered.contains(lead_move))
        {
            if !failed.contains(lead_move) {
                failed.push(lead_move.clone());
            }
        }
        self.lift_handoffs(index_name, nodes, &failed).await;
        for lead_move in failed.iter().filter(|lead_move| !lead_move.draining) {
            keep_lead(&mut next, lead_move);
        }
        next
    }
}
