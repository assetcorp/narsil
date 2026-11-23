use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use narsil::ErrorCode;

use super::PrimaryWrites;
use super::errors::{
    LEASE_LAPSED, ended_term, initialising_refusal, is_outcome_unknown, no_longer_leads,
    outcome_unknown, stopped_leading,
};
use super::partition::{Partition, QueueTurn};
use crate::allocator::{Assignment, INITIALISING};
use crate::constants::{REGISTRATION_LEASE_CONFIRM_TIMEOUT_MS, REGISTRATION_LEASE_DRIFT_SHARE};
use crate::coordinator::RegistrationLease;
use crate::error::{ClusterError, ClusterResult};
use crate::payload::forward::WriteFailure;

#[derive(Debug, Clone)]
pub(super) struct Scope {
    pub(super) index_name: String,
    pub(super) partition_id: u32,
    pub(super) primary_term: u64,
    pub(super) assignment: Assignment,
    pub(super) index_uuid: Option<String>,
}

pub(super) type Outcome = Result<(), WriteFailure>;

fn lease_lapsed(lease: Option<&RegistrationLease>) -> bool {
    lease.is_none_or(|lease| lease.remaining_ms <= lease.ttl_ms * REGISTRATION_LEASE_DRIFT_SHARE)
}

fn initialising_here(assignment: Option<&Assignment>, node_id: &str) -> bool {
    assignment.is_some_and(|assignment| {
        assignment.is_primary(node_id) && assignment.state == INITIALISING
    })
}

fn refused_from_local_copy(error: &ClusterError) -> bool {
    error.code() == ErrorCode::DOC_NOT_FOUND.as_str()
        || error.code() == ErrorCode::DOC_ALREADY_EXISTS.as_str()
}

impl PrimaryWrites {
    async fn registration_lease_lapsed(&self) -> bool {
        let lease = self.coordinator.registration_lease(&self.node_id);
        if !lease_lapsed(lease.as_ref()) {
            return false;
        }
        let confirm_within = Duration::from_millis(REGISTRATION_LEASE_CONFIRM_TIMEOUT_MS);
        let confirming = self.coordinator.confirm_registration_lease(&self.node_id);
        let confirmed = tokio::time::timeout(confirm_within, confirming)
            .await
            .ok()
            .flatten();
        lease_lapsed(confirmed.as_ref())
    }

    pub(super) async fn copy_failed(self: &Arc<Self>, index_name: &str, partition_id: u32) -> bool {
        self.failures.is_failed(index_name, partition_id)
            || self.held_failure(index_name, partition_id).await.is_some()
    }

    async fn writable_assignment(
        &self,
        index_name: &str,
        partition_id: u32,
    ) -> ClusterResult<(Option<String>, Option<Assignment>)> {
        let table = self.view.read(index_name).await?;
        let assignment = table
            .as_ref()
            .and_then(|table| table.assignments.get(f64::from(partition_id)))
            .cloned();
        if !initialising_here(assignment.as_ref(), &self.node_id) {
            return Ok((table.and_then(|table| table.index_uuid), assignment));
        }
        let refusal = || initialising_refusal(index_name, partition_id, &self.node_id);
        let live = self
            .view
            .read_live(index_name)
            .await
            .map_err(|_| refusal())?;
        let assignment = live
            .as_ref()
            .and_then(|table| table.assignments.get(f64::from(partition_id)))
            .cloned();
        if initialising_here(assignment.as_ref(), &self.node_id) {
            return Err(refusal());
        }
        Ok((live.and_then(|table| table.index_uuid), assignment))
    }

    pub(super) async fn current_scope(
        self: &Arc<Self>,
        partition: &Partition,
        index_name: &str,
        partition_id: u32,
    ) -> ClusterResult<Scope> {
        let (index_uuid, assignment) = self.writable_assignment(index_name, partition_id).await?;
        let assignment = match assignment {
            Some(assignment) if assignment.is_primary(&self.node_id) => assignment,
            other => {
                let primary = other.as_ref().and_then(|held| held.primary.as_deref());
                return Err(stopped_leading(
                    index_name,
                    partition_id,
                    &self.node_id,
                    primary,
                ));
            }
        };
        if self.copy_failed(index_name, partition_id).await
            || self.registration_lease_lapsed().await
        {
            let primary = assignment.primary.as_deref();
            return Err(stopped_leading(
                index_name,
                partition_id,
                &self.node_id,
                primary,
            ));
        }
        self.assert_reshard_open(index_name, partition_id, assignment.primary_term as u64)
            .await?;
        let scope = Scope {
            index_name: index_name.to_string(),
            partition_id,
            primary_term: assignment.primary_term as u64,
            assignment,
            index_uuid,
        };
        let accepted = crate::controller::lock(&partition.terms).accepted;
        if accepted > scope.primary_term {
            return Err(ended_term(&scope, &self.node_id, accepted));
        }
        Ok(scope)
    }

    pub(super) async fn leadership_unconfirmed(&self, scope: &Scope) -> bool {
        let Ok(Some(live)) = self.view.read_live(&scope.index_name).await else {
            return true;
        };
        live.assignments
            .get(f64::from(scope.partition_id))
            .is_none_or(|assignment| {
                !assignment.is_primary(&self.node_id)
                    || assignment.primary_term as u64 > scope.primary_term
            })
    }

    async fn log_end(&self, scope: &Scope) -> Option<u64> {
        let name = scope.index_name.clone();
        let partition_id = scope.partition_id;
        self.on_copies(move |copies| copies.position(&name, partition_id))
            .await
            .ok()
            .map(|position| position.seq_no)
    }

    async fn scope_in_queue(
        self: &Arc<Self>,
        partition: &Partition,
        index_name: &str,
        partition_id: u32,
    ) -> ClusterResult<Scope> {
        let scope = self
            .current_scope(partition, index_name, partition_id)
            .await?;
        if !self.start_term_in_queue(partition, &scope).await? {
            return Ok(scope);
        }
        self.current_scope(partition, index_name, partition_id)
            .await
    }

    pub(super) async fn in_leading_queue<F, Fut>(
        self: &Arc<Self>,
        index_name: &str,
        partition_id: u32,
        positions: &[usize],
        task: F,
    ) -> Vec<(usize, Outcome)>
    where
        F: FnOnce(Scope, QueueTurn) -> Fut,
        Fut: Future<Output = Vec<(usize, Outcome)>>,
    {
        let partition = self.partitions.of(index_name, partition_id);
        let turn = partition.turn().await;
        let scope = match self
            .scope_in_queue(&partition, index_name, partition_id)
            .await
        {
            Ok(scope) => scope,
            Err(error) => {
                drop(turn);
                let error = self
                    .refusal_before_task(index_name, partition_id, error)
                    .await;
                return positions
                    .iter()
                    .map(|position| (*position, Err(WriteFailure::from(error.clone()))))
                    .collect();
            }
        };
        let log_end_before = self.log_end(&scope).await;
        let mut outcomes = task(scope.clone(), turn).await;
        if self.registration_lease_lapsed().await {
            let refusal = no_longer_leads(&scope, &self.node_id);
            let grew = log_end_before.is_none() || self.log_end(&scope).await != log_end_before;
            let error = if grew {
                outcome_unknown(
                    &scope,
                    &refusal,
                    LEASE_LAPSED,
                    "its registration lease lapsed before it could acknowledge the write",
                )
            } else {
                refusal
            };
            for (_, outcome) in &mut outcomes {
                if outcome.is_ok() {
                    *outcome = Err(WriteFailure::from(error.clone()));
                }
            }
            return outcomes;
        }
        self.confirm_refusals(&scope, &mut outcomes).await;
        outcomes
    }

    async fn refusal_before_task(
        self: &Arc<Self>,
        index_name: &str,
        partition_id: u32,
        error: ClusterError,
    ) -> ClusterError {
        if is_outcome_unknown(&error) {
            return error;
        }
        if self.copy_failed(index_name, partition_id).await {
            return stopped_leading(index_name, partition_id, &self.node_id, None);
        }
        error
    }

    async fn confirm_refusals(&self, scope: &Scope, outcomes: &mut [(usize, Outcome)]) {
        let refused = |outcome: &Outcome| matches!(outcome, Err(failure) if refused_from_local_copy(&failure.error));
        if !outcomes.iter().any(|(_, outcome)| refused(outcome)) {
            return;
        }
        if !self.leadership_unconfirmed(scope).await {
            return;
        }
        for (_, outcome) in outcomes.iter_mut() {
            if refused(outcome) {
                *outcome = Err(WriteFailure::from(no_longer_leads(scope, &self.node_id)));
            }
        }
    }
}
