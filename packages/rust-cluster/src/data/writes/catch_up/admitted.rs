use super::state::{AdmittedReplica, CatchUp, PendingAdmission, ToWithdraw};
use crate::allocator::Assignment;
use crate::controller::lock;
use crate::data::writes::partition::Partition;

pub(in crate::data::writes) struct Fenced {
    pub(in crate::data::writes) pending: Option<u64>,
    pub(in crate::data::writes) owed: Option<u64>,
}

impl CatchUp {
    pub(in crate::data::writes) fn with_unanswered(
        &self,
        local_node_id: &str,
        mut targets: Vec<String>,
    ) -> Vec<String> {
        for (replica_node_id, admission) in &self.pending {
            if admission.unanswered
                && replica_node_id != local_node_id
                && !targets.contains(replica_node_id)
            {
                targets.push(replica_node_id.clone());
            }
        }
        targets
    }

    pub(in crate::data::writes) fn settle_fenced(
        &mut self,
        replica_node_id: &str,
        fenced: &Fenced,
    ) {
        if let Some(claim) = fenced.pending
            && self
                .pending
                .get(replica_node_id)
                .is_some_and(|pending| pending.unanswered)
        {
            self.clear_pending(replica_node_id, claim);
        }
        if let Some(claim) = fenced.owed
            && self
                .to_withdraw
                .get(replica_node_id)
                .is_some_and(|owed| owed.claim == claim)
        {
            self.to_withdraw.remove(replica_node_id);
        }
    }

    pub(in crate::data::writes) fn record_to_withdraw(
        &mut self,
        replica_node_id: &str,
        primary_term: u64,
    ) {
        let claim = self.next_claim();
        self.to_withdraw.insert(
            replica_node_id.to_string(),
            ToWithdraw {
                claim,
                primary_term,
                withdrawing: false,
            },
        );
    }

    pub(in crate::data::writes) fn settled_admissions(
        &self,
        assignment: &Assignment,
    ) -> Vec<(String, u64)> {
        self.admitted
            .iter()
            .filter(|(replica_node_id, record)| {
                assignment.holds_in_sync(replica_node_id)
                    && record.primary_term == assignment.primary_term as u64
            })
            .map(|(replica_node_id, record)| (replica_node_id.clone(), record.generation))
            .collect()
    }

    pub(in crate::data::writes) fn forget_settled(
        &mut self,
        replica_node_id: &str,
        generation: u64,
    ) {
        if self
            .admitted
            .get(replica_node_id)
            .is_some_and(|record| record.generation == generation)
        {
            self.admitted.remove(replica_node_id);
        }
    }

    pub(in crate::data::writes) fn admitted_beyond_table(
        &mut self,
        assignment: &Assignment,
        generation_at_live_read: Option<u64>,
    ) -> Vec<String> {
        let version = assignment.in_sync_version_of() as u64;
        let term = assignment.primary_term as u64;
        let mut beyond = Vec::new();
        self.admitted.retain(|replica_node_id, record| {
            let in_sync = assignment.holds_in_sync(replica_node_id);
            let superseded = match generation_at_live_read {
                Some(generation) => record.generation <= generation,
                None => version > record.in_sync_version,
            };
            let left = !assignment.holds_replica(replica_node_id) || record.primary_term != term;
            if left || (in_sync && generation_at_live_read.is_none()) || (superseded && !in_sync) {
                return false;
            }
            if !in_sync {
                beyond.push(replica_node_id.clone());
            }
            true
        });
        beyond
    }

    pub(in crate::data::writes) fn pending_of(
        &self,
        replica_node_id: &str,
    ) -> Option<&PendingAdmission> {
        self.pending.get(replica_node_id)
    }
}

impl Partition {
    pub(in crate::data::writes) fn mark_pending_admission(
        &self,
        replica_node_id: &str,
    ) -> Option<u64> {
        let mut catch_up = lock(&self.catch_up);
        if catch_up.pending.contains_key(replica_node_id) {
            return None;
        }
        let claim = catch_up.next_claim();
        catch_up.pending.insert(
            replica_node_id.to_string(),
            PendingAdmission {
                claim,
                failed_write: false,
                unanswered: false,
                answer: None,
            },
        );
        catch_up.advance_generation(replica_node_id);
        lock(&self.terms).removed.remove(replica_node_id);
        Some(claim)
    }

    pub(in crate::data::writes) fn record_admitted(
        &self,
        replica_node_id: &str,
        primary_term: u64,
        in_sync_version: u64,
    ) {
        let mut catch_up = lock(&self.catch_up);
        catch_up.to_withdraw.remove(replica_node_id);
        let generation = catch_up.advance_generation(replica_node_id);
        catch_up.admitted.insert(
            replica_node_id.to_string(),
            AdmittedReplica {
                primary_term,
                generation,
                in_sync_version,
            },
        );
        lock(&self.terms).removed.remove(replica_node_id);
    }

    pub(in crate::data::writes) fn record_removal_unless_readmitted(
        &self,
        replica_node_id: &str,
        primary_term: u64,
        generation_at_removal: u64,
    ) {
        let mut catch_up = lock(&self.catch_up);
        if !catch_up.generation_is(replica_node_id, generation_at_removal) {
            return;
        }
        catch_up.admitted.remove(replica_node_id);
        lock(&self.terms)
            .removed
            .insert(replica_node_id.to_string(), primary_term);
    }

    pub(in crate::data::writes) fn generation_of(&self, replica_node_id: &str) -> u64 {
        lock(&self.catch_up).generation_of(replica_node_id)
    }
}
