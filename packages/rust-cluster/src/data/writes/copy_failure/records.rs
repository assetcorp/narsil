use std::collections::HashMap;
use std::sync::Mutex;

use crate::controller::lock;

struct FailedCopy {
    claim: u64,
    reloaded: Option<bool>,
    missing: bool,
    recovering: bool,
}

#[derive(Default)]
struct Records {
    by_index: HashMap<String, HashMap<u32, FailedCopy>>,
    claims: u64,
}

impl Records {
    fn of(&self, index_name: &str, partition_id: u32) -> Option<&FailedCopy> {
        self.by_index.get(index_name)?.get(&partition_id)
    }

    fn of_mut(&mut self, index_name: &str, partition_id: u32) -> Option<&mut FailedCopy> {
        self.by_index.get_mut(index_name)?.get_mut(&partition_id)
    }

    fn next_claim(&mut self) -> u64 {
        self.claims += 1;
        self.claims
    }

    fn remove(&mut self, index_name: &str, partition_id: u32) {
        if let Some(partitions) = self.by_index.get_mut(index_name) {
            partitions.remove(&partition_id);
            if partitions.is_empty() {
                self.by_index.remove(index_name);
            }
        }
    }
}

#[derive(Default)]
pub(in crate::data::writes) struct CopyFailures {
    records: Mutex<Records>,
}

impl CopyFailures {
    pub(in crate::data::writes) fn is_failed(&self, index_name: &str, partition_id: u32) -> bool {
        lock(&self.records).of(index_name, partition_id).is_some()
    }

    pub(super) fn is_unlisted(&self, index_name: &str, partition_id: u32) -> bool {
        lock(&self.records)
            .of(index_name, partition_id)
            .is_some_and(|copy| copy.reloaded != Some(true))
    }

    pub(super) fn is_missing(&self, index_name: &str, partition_id: u32) -> bool {
        lock(&self.records)
            .of(index_name, partition_id)
            .is_some_and(|copy| copy.missing)
    }

    pub(super) fn is_current(&self, index_name: &str, partition_id: u32, claim: u64) -> bool {
        lock(&self.records)
            .of(index_name, partition_id)
            .is_some_and(|copy| copy.claim == claim)
    }

    pub(super) fn claim(&self, index_name: &str, partition_id: u32) -> Option<u64> {
        let mut records = lock(&self.records);
        if records.of(index_name, partition_id).is_some() {
            return None;
        }
        let claim = records.next_claim();
        records
            .by_index
            .entry(index_name.to_string())
            .or_default()
            .insert(
                partition_id,
                FailedCopy {
                    claim,
                    reloaded: None,
                    missing: false,
                    recovering: true,
                },
            );
        Some(claim)
    }

    pub(super) fn claim_missing(&self, index_name: &str, partition_id: u32) -> Option<Option<u64>> {
        let mut records = lock(&self.records);
        let claim = records.next_claim();
        if let Some(copy) = records.of_mut(index_name, partition_id) {
            if copy.missing {
                return None;
            }
            copy.missing = true;
            copy.reloaded = None;
            if copy.recovering {
                return Some(None);
            }
            copy.recovering = true;
            copy.claim = claim;
            return Some(Some(claim));
        }
        records
            .by_index
            .entry(index_name.to_string())
            .or_default()
            .insert(
                partition_id,
                FailedCopy {
                    claim,
                    reloaded: None,
                    missing: true,
                    recovering: true,
                },
            );
        Some(Some(claim))
    }

    pub(super) fn note_reloaded(
        &self,
        index_name: &str,
        partition_id: u32,
        claim: u64,
        reloaded: bool,
    ) {
        if let Some(copy) = lock(&self.records).of_mut(index_name, partition_id)
            && copy.claim == claim
        {
            copy.reloaded = Some(reloaded);
        }
    }

    pub(super) fn finish(&self, index_name: &str, partition_id: u32, claim: u64, reset: bool) {
        let mut records = lock(&self.records);
        let Some(copy) = records.of_mut(index_name, partition_id) else {
            return;
        };
        if copy.claim != claim {
            return;
        }
        if !reset {
            copy.recovering = false;
            return;
        }
        records.remove(index_name, partition_id);
    }

    pub(in crate::data::writes) fn forget_index(&self, index_name: &str) {
        lock(&self.records).by_index.remove(index_name);
    }

    pub(in crate::data::writes) fn forget_partition(&self, index_name: &str, partition_id: u32) {
        lock(&self.records).remove(index_name, partition_id);
    }
}
