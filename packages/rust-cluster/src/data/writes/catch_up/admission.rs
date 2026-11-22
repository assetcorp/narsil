use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;
use tokio::task::JoinHandle;

use super::state::AdmissionAnswer;
use crate::allocator::ACTIVE;
use crate::constants::{
    ADMISSION_RETRIES_AFTER_IN_SYNC_CHANGE, ADMISSION_TIMEOUT_MS, CONTROLLER_LEASE_KEY,
};
use crate::controller::lock;
use crate::data::writes::PrimaryWrites;
use crate::data::writes::partition::Partition;
use crate::data::writes::scope::Scope;
use crate::message::message_types;
use crate::payload::ack::{encode_insync_remove, insync_confirmed};
use crate::payload::sync::{InsyncAdmission, encode_insync_add};

struct Claim {
    replica_node_id: String,
    claim: u64,
    proposed_epoch: u64,
}

#[derive(Clone, Copy)]
struct ClaimedPosition {
    applied_seq_no: u64,
    commit_point: u64,
}

struct Settle<'a> {
    partition: &'a Partition,
    replica_node_id: &'a str,
    claim: u64,
    answer: watch::Sender<Option<AdmissionAnswer>>,
}

impl Drop for Settle<'_> {
    fn drop(&mut self) {
        self.answer.send_if_modified(|answer| {
            if answer.is_some() {
                return false;
            }
            *answer = Some(AdmissionAnswer::Refused);
            true
        });
        let mut catch_up = lock(&self.partition.catch_up);
        let unanswered = catch_up
            .pending_of(self.replica_node_id)
            .is_some_and(|pending| pending.claim == self.claim && pending.unanswered);
        if !unanswered {
            catch_up.clear_pending(self.replica_node_id, self.claim);
        }
    }
}

fn admission_timeout() -> Duration {
    Duration::from_millis(ADMISSION_TIMEOUT_MS)
}

impl PrimaryWrites {
    pub(in crate::data::writes) fn claim_admission(
        &self,
        partition: &Partition,
        replica_node_id: &str,
    ) -> Option<u64> {
        let commit_point = lock(&partition.log).commit_point();
        let qualifies = lock(&partition.catch_up)
            .cursors
            .get(replica_node_id)
            .is_some_and(|cursor| cursor.confirmed && cursor.applied_seq_no >= commit_point);
        if !qualifies {
            return None;
        }
        partition.mark_pending_admission(replica_node_id)
    }

    pub(in crate::data::writes) fn spawn_admission(
        self: &Arc<Self>,
        partition: &Arc<Partition>,
        scope: &Scope,
        replica_node_id: &str,
        claim: u64,
    ) -> JoinHandle<()> {
        let (writes, partition, scope, replica) = (
            Arc::clone(self),
            Arc::clone(partition),
            scope.clone(),
            replica_node_id.to_string(),
        );
        tokio::spawn(async move {
            writes
                .request_claimed_admission(&partition, &scope, &replica, claim)
                .await;
        })
    }

    async fn request_claimed_admission(
        &self,
        partition: &Partition,
        scope: &Scope,
        replica_node_id: &str,
        claim: u64,
    ) {
        let (answer, answered) = watch::channel(None);
        let claimed = {
            let mut catch_up = lock(&partition.catch_up);
            let epoch = catch_up
                .cursors
                .get(replica_node_id)
                .map(|cursor| cursor.sync_epoch);
            match (catch_up.pending.get_mut(replica_node_id), epoch) {
                (Some(pending), Some(epoch)) if pending.claim == claim => {
                    pending.answer = Some(answered);
                    Some(epoch)
                }
                _ => None,
            }
        };
        let settle = Settle {
            partition,
            replica_node_id,
            claim,
            answer,
        };
        let Some(proposed_epoch) = claimed else {
            return;
        };
        let Ok(Some(controller)) = self.coordinator.lease_holder(CONTROLLER_LEASE_KEY).await else {
            return;
        };
        let request = Claim {
            replica_node_id: replica_node_id.to_string(),
            claim,
            proposed_epoch,
        };
        let initial_version = scope.assignment.in_sync_version_of() as u64;
        let (answer, version) = self
            .ask_controller(partition, scope, &request, &controller, initial_version)
            .await;
        let failed_write = {
            let mut catch_up = lock(&partition.catch_up);
            match catch_up.pending.get_mut(replica_node_id) {
                Some(pending) if pending.claim == claim => {
                    pending.unanswered = answer == AdmissionAnswer::Unanswered;
                    pending.failed_write
                }
                _ => false,
            }
        };
        settle.answer.send_replace(Some(answer));
        let accepted = answer == AdmissionAnswer::Accepted;
        if accepted && failed_write {
            lock(&partition.catch_up).record_to_withdraw(replica_node_id, scope.primary_term);
            return;
        }
        let outlived = accepted && self.epoch_moved(partition, replica_node_id, proposed_epoch);
        let withdrawn = outlived
            && tokio::time::timeout(
                admission_timeout(),
                self.withdraw_admission(scope, replica_node_id, scope.primary_term, &controller),
            )
            .await
            .unwrap_or(false);
        if answer == AdmissionAnswer::Unanswered || (outlived && !withdrawn) {
            lock(&partition.catch_up).record_to_withdraw(replica_node_id, scope.primary_term);
        } else if accepted && !outlived {
            partition.record_admitted(replica_node_id, scope.primary_term, version);
        }
    }

    fn claimed_position(partition: &Partition, request: &Claim) -> Option<ClaimedPosition> {
        let commit_point = lock(&partition.log).commit_point();
        let catch_up = lock(&partition.catch_up);
        let cursor = catch_up
            .cursors
            .get(&request.replica_node_id)
            .filter(|cursor| cursor.sync_epoch == request.proposed_epoch && cursor.confirmed)?;
        Some(ClaimedPosition {
            applied_seq_no: cursor.applied_seq_no,
            commit_point,
        })
    }

    fn claim_holds(&self, partition: &Partition, request: &Claim) -> bool {
        let catch_up = lock(&partition.catch_up);
        let pending_holds = catch_up
            .pending_of(&request.replica_node_id)
            .is_some_and(|pending| pending.claim == request.claim && !pending.failed_write);
        let epoch_holds = catch_up
            .cursors
            .get(&request.replica_node_id)
            .is_some_and(|cursor| cursor.sync_epoch == request.proposed_epoch);
        pending_holds && epoch_holds
    }

    async fn ask_controller(
        &self,
        partition: &Partition,
        scope: &Scope,
        request: &Claim,
        controller: &str,
        initial_version: u64,
    ) -> (AdmissionAnswer, u64) {
        let mut version = initial_version;
        let mut retries = 0;
        while self.claim_holds(partition, request) {
            let Some(started_at) = self.registered_started_at(&request.replica_node_id).await
            else {
                break;
            };
            let Some(position) = Self::claimed_position(partition, request) else {
                break;
            };
            if !self
                .prove_position(
                    partition,
                    scope,
                    &request.replica_node_id,
                    position.applied_seq_no,
                )
                .await
                || !self.claim_holds(partition, request)
            {
                break;
            }
            let admission = InsyncAdmission {
                index_name: &scope.index_name,
                partition_id: scope.partition_id,
                replica_node_id: &request.replica_node_id,
                primary_term: scope.primary_term,
                applied_seq_no: position.applied_seq_no,
                commit_point: position.commit_point,
                in_sync_version: version,
                replica_started_at: &started_at,
            };
            let answer = tokio::time::timeout(
                admission_timeout(),
                self.send_to_controller(&admission, controller),
            )
            .await
            .unwrap_or(AdmissionAnswer::Unanswered);
            if answer != AdmissionAnswer::Refused
                || retries >= ADMISSION_RETRIES_AFTER_IN_SYNC_CHANGE
            {
                return (answer, version);
            }
            let changed = self
                .changed_in_sync_version(scope, request, position, version)
                .await;
            let Some(changed) = changed else {
                return (answer, version);
            };
            version = changed;
            retries += 1;
        }
        (AdmissionAnswer::Refused, version)
    }

    async fn send_to_controller(
        &self,
        admission: &InsyncAdmission<'_>,
        controller: &str,
    ) -> AdmissionAnswer {
        let Ok(message) = self.message(
            message_types::REPLICATION_INSYNC_ADD,
            encode_insync_add(admission),
        ) else {
            return AdmissionAnswer::Unanswered;
        };
        let mut sent_without_answer = false;
        for target in self.view.targets(controller) {
            let confirmed = match self.transport.send(&target, message.clone()).await {
                Ok(answer) if !answer.is_failure() => insync_confirmed(&answer.payload),
                _ => None,
            };
            match confirmed {
                Some(true) => return AdmissionAnswer::Accepted,
                Some(false) if sent_without_answer => return AdmissionAnswer::Unanswered,
                Some(false) => return AdmissionAnswer::Refused,
                None => sent_without_answer = true,
            }
        }
        AdmissionAnswer::Unanswered
    }

    pub(in crate::data::writes) async fn withdraw_admission(
        &self,
        scope: &Scope,
        replica_node_id: &str,
        primary_term: u64,
        controller: &str,
    ) -> bool {
        let payload = encode_insync_remove(
            &scope.index_name,
            scope.partition_id,
            replica_node_id,
            primary_term,
        );
        let Ok(message) = self.message(message_types::REPLICATION_INSYNC_REMOVE, payload) else {
            return false;
        };
        for target in self.view.targets(controller) {
            if let Ok(answer) = self.transport.send(&target, message.clone()).await
                && !answer.is_failure()
                && insync_confirmed(&answer.payload) == Some(true)
            {
                return true;
            }
        }
        false
    }

    async fn registered_started_at(&self, replica_node_id: &str) -> Option<String> {
        let nodes = self.coordinator.list_nodes().await.ok()?;
        nodes
            .into_iter()
            .find(|node| node.node_id == replica_node_id)
            .map(|node| node.started_at)
    }

    async fn changed_in_sync_version(
        &self,
        scope: &Scope,
        request: &Claim,
        position: ClaimedPosition,
        version: u64,
    ) -> Option<u64> {
        let table = self.view.read_live(&scope.index_name).await.ok()??;
        let assignment = table.assignments.get(f64::from(scope.partition_id))?;
        let current = assignment.in_sync_version_of() as u64;
        let replica = request.replica_node_id.as_str();
        let qualifies = current != version
            && assignment.is_primary(&self.node_id)
            && assignment.primary_term as u64 == scope.primary_term
            && assignment.state == ACTIVE
            && assignment.holds_replica(replica)
            && !assignment.holds_in_sync(replica)
            && position.applied_seq_no as f64 >= assignment.commit_point;
        qualifies.then_some(current)
    }
}
