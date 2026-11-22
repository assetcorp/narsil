use std::sync::Arc;
use std::time::Duration;

use super::admitted::Fenced;
use crate::constants::{ADMISSION_TIMEOUT_MS, CONTROLLER_LEASE_KEY};
use crate::controller::lock;
use crate::data::writes::PrimaryWrites;
use crate::data::writes::partition::Partition;
use crate::data::writes::scope::Scope;

struct Owed {
    replica_node_id: String,
    claim: u64,
    primary_term: u64,
}

impl PrimaryWrites {
    pub(in crate::data::writes) fn withdraw_applied_admissions(
        self: &Arc<Self>,
        partition: &Arc<Partition>,
        scope: &Scope,
    ) {
        let started = {
            let mut catch_up = lock(&partition.catch_up);
            let owed: Vec<(String, u64, u64, bool)> = catch_up
                .to_withdraw
                .iter()
                .map(|(replica, owed)| {
                    (
                        replica.clone(),
                        owed.claim,
                        owed.primary_term,
                        owed.withdrawing,
                    )
                })
                .collect();
            let mut started = Vec::new();
            for (replica_node_id, claim, primary_term, withdrawing) in owed {
                let pending = catch_up
                    .pending_of(&replica_node_id)
                    .map(|pending| (pending.claim, pending.unanswered));
                if primary_term != scope.primary_term {
                    let fenced = Fenced {
                        pending: pending.map(|(claim, _)| claim),
                        owed: Some(claim),
                    };
                    catch_up.settle_fenced(&replica_node_id, &fenced);
                    continue;
                }
                if withdrawing || pending.is_some_and(|(_, unanswered)| !unanswered) {
                    continue;
                }
                if let Some(owed) = catch_up.to_withdraw.get_mut(&replica_node_id) {
                    owed.withdrawing = true;
                }
                started.push((
                    Owed {
                        replica_node_id,
                        claim,
                        primary_term,
                    },
                    pending.map(|(claim, _)| claim),
                ));
            }
            started
        };
        for (owed, pending) in started {
            let (writes, partition, scope) =
                (Arc::clone(self), Arc::clone(partition), scope.clone());
            tokio::spawn(async move {
                writes
                    .withdraw_applied_admission(&partition, &scope, &owed, pending)
                    .await;
                let mut catch_up = lock(&partition.catch_up);
                if let Some(held) = catch_up.to_withdraw.get_mut(&owed.replica_node_id)
                    && held.claim == owed.claim
                {
                    held.withdrawing = false;
                }
            });
        }
    }

    async fn withdraw_applied_admission(
        &self,
        partition: &Partition,
        scope: &Scope,
        owed: &Owed,
        pending: Option<u64>,
    ) {
        let Ok(Some(controller)) = self.coordinator.lease_holder(CONTROLLER_LEASE_KEY).await else {
            return;
        };
        let withdrawal =
            self.withdraw_admission(scope, &owed.replica_node_id, owed.primary_term, &controller);
        let withdrawn =
            tokio::time::timeout(Duration::from_millis(ADMISSION_TIMEOUT_MS), withdrawal)
                .await
                .unwrap_or(false);
        if !withdrawn {
            return;
        }
        let mut catch_up = lock(&partition.catch_up);
        let still_owed = catch_up
            .to_withdraw
            .get(&owed.replica_node_id)
            .is_some_and(|held| held.claim == owed.claim);
        let fenced = Fenced {
            pending,
            owed: Some(owed.claim),
        };
        catch_up.settle_fenced(&owed.replica_node_id, &fenced);
        if !still_owed {
            return;
        }
        catch_up.admitted.remove(&owed.replica_node_id);
        if catch_up.pending_of(&owed.replica_node_id).is_none() {
            lock(&partition.terms)
                .removed
                .insert(owed.replica_node_id.clone(), owed.primary_term);
        }
    }
}
