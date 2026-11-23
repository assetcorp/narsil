use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::watch;

use crate::controller::lock;
use crate::error::ClusterError;

pub(super) type PartitionKey = (String, u32);
pub(super) type JobKey = (String, u32);

#[derive(Debug, Clone)]
pub(super) struct ReshardBlock {
    pub(super) job_id: String,
    pub(super) partition_id: u32,
    pub(super) marker: u64,
}

#[derive(Debug, Clone)]
pub(super) enum SnapshotAnswer {
    Pending,
    Announced(u64),
    Refused(ClusterError),
}

pub(super) struct ReshardCopyJob {
    pub(super) job_id: String,
    pub(super) index_name: String,
    pub(super) source_generation: String,
    pub(super) target_generation: String,
    pub(super) partition_id: u32,
    pub(super) source_partition_count: u32,
    pub(super) target_partition_count: u32,
    pub(super) primary_term: u64,
    stopped: AtomicBool,
    pub(super) snapshot_seq_no: watch::Sender<SnapshotAnswer>,
}

pub(super) struct ReshardStart {
    pub(super) index_name: String,
    pub(super) job_id: String,
    pub(super) source_generation: String,
    pub(super) target_generation: String,
    pub(super) partition_id: u32,
    pub(super) source_partition_count: u32,
    pub(super) target_partition_count: u32,
}

impl ReshardCopyJob {
    pub(super) fn new(start: ReshardStart, primary_term: u64) -> ReshardCopyJob {
        ReshardCopyJob {
            job_id: start.job_id,
            index_name: start.index_name,
            source_generation: start.source_generation,
            target_generation: start.target_generation,
            partition_id: start.partition_id,
            source_partition_count: start.source_partition_count,
            target_partition_count: start.target_partition_count,
            primary_term,
            stopped: AtomicBool::new(false),
            snapshot_seq_no: watch::Sender::new(SnapshotAnswer::Pending),
        }
    }

    pub(super) fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::Acquire)
    }

    pub(super) fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
    }

    pub(super) fn announce(&self, snapshot_seq_no: u64) {
        self.snapshot_seq_no.send_if_modified(|held| {
            if matches!(held, SnapshotAnswer::Pending) {
                *held = SnapshotAnswer::Announced(snapshot_seq_no);
                return true;
            }
            false
        });
    }

    pub(super) fn refuse(&self, error: ClusterError) {
        self.snapshot_seq_no.send_if_modified(|held| {
            if matches!(held, SnapshotAnswer::Pending) {
                *held = SnapshotAnswer::Refused(error);
                return true;
            }
            false
        });
    }
}

#[derive(Default)]
pub(super) struct ReshardHeld {
    pub(super) blocks: HashMap<PartitionKey, ReshardBlock>,
    pub(super) checked_terms: HashMap<PartitionKey, u64>,
    pub(super) public_names: HashMap<String, String>,
    pub(super) jobs: HashMap<JobKey, Arc<ReshardCopyJob>>,
    pub(super) accepted_terms: HashMap<JobKey, u64>,
    pub(super) next_marker: u64,
}

impl ReshardHeld {
    pub(super) fn set_block(&mut self, index_name: &str, job_id: &str, partition_id: u32) {
        self.next_marker += 1;
        self.blocks.insert(
            (index_name.to_string(), partition_id),
            ReshardBlock {
                job_id: job_id.to_string(),
                partition_id,
                marker: self.next_marker,
            },
        );
    }
}

#[derive(Default)]
pub(in crate::data) struct ReshardState {
    held: Mutex<ReshardHeld>,
}

impl ReshardState {
    pub(super) fn with<T>(&self, work: impl FnOnce(&mut ReshardHeld) -> T) -> T {
        work(&mut lock(&self.held))
    }

    pub(in crate::data) fn forget_index(&self, index_name: &str) {
        self.with(|held| {
            held.blocks.retain(|key, _| key.0 != index_name);
            held.checked_terms.retain(|key, _| key.0 != index_name);
        });
    }

    pub(in crate::data) fn forget_partition(&self, index_name: &str, partition_id: u32) {
        let key = (index_name.to_string(), partition_id);
        self.with(|held| {
            held.blocks.remove(&key);
            held.checked_terms.remove(&key);
        });
    }

    pub(in crate::data) fn stop_every_job(&self) {
        self.with(|held| {
            for job in held.jobs.values() {
                job.stop();
            }
            held.jobs.clear();
        });
    }
}
