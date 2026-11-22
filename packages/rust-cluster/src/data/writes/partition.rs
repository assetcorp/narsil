use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};

use tokio::sync::{OwnedMutexGuard, watch};
use tokio::task::JoinHandle;

use super::catch_up::CatchUp;
use super::log::ReplicationLog;
use crate::controller::lock;

pub(super) type PartitionKey = (String, u32);

#[derive(Default)]
pub(super) struct Terms {
    pub(super) started: u64,
    pub(super) accepted: u64,
    pub(super) out_of_step_claim: u64,
    pub(super) removed: HashMap<String, u64>,
}

impl Terms {
    pub(super) fn removed_under(&self, replica_node_id: &str, primary_term: u64) -> bool {
        self.removed
            .get(replica_node_id)
            .is_some_and(|term| *term == primary_term)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SupersedingPrimary {
    pub(super) node_id: String,
    pub(super) primary_term: u64,
}

#[derive(Default)]
pub(super) struct Partition {
    queue: Arc<tokio::sync::Mutex<()>>,
    pub(super) log: Mutex<ReplicationLog>,
    pub(super) terms: Mutex<Terms>,
    pub(super) superseding: watch::Sender<Option<SupersedingPrimary>>,
    pub(super) catch_up: Mutex<CatchUp>,
}

pub(super) struct QueueTurn {
    guard: Option<OwnedMutexGuard<()>>,
}

impl QueueTurn {
    pub(super) fn hold_through<T, F>(&mut self, work: F) -> JoinHandle<T>
    where
        T: Send + 'static,
        F: Future<Output = T> + Send + 'static,
    {
        let guard = self.guard.take();
        tokio::spawn(async move {
            let output = work.await;
            drop(guard);
            output
        })
    }
}

impl Partition {
    pub(super) async fn turn(&self) -> QueueTurn {
        QueueTurn {
            guard: Some(Arc::clone(&self.queue).lock_owned().await),
        }
    }

    pub(super) fn note_superseding(&self, node_id: &str, primary_term: u64) {
        self.superseding.send_if_modified(|held| {
            if held
                .as_ref()
                .is_some_and(|held| held.primary_term >= primary_term)
            {
                return false;
            }
            *held = Some(SupersedingPrimary {
                node_id: node_id.to_string(),
                primary_term,
            });
            true
        });
    }

    pub(super) fn note_accepted(&self, primary_term: u64) {
        let mut terms = lock(&self.terms);
        terms.accepted = terms.accepted.max(primary_term);
    }
}

#[derive(Default)]
pub(super) struct Partitions {
    held: Mutex<HashMap<PartitionKey, Arc<Partition>>>,
}

impl Partitions {
    pub(super) fn of(&self, index_name: &str, partition_id: u32) -> Arc<Partition> {
        let mut held = lock(&self.held);
        Arc::clone(
            held.entry((index_name.to_string(), partition_id))
                .or_default(),
        )
    }

    pub(super) fn held(&self) -> Vec<(PartitionKey, Arc<Partition>)> {
        lock(&self.held)
            .iter()
            .map(|(key, partition)| (key.clone(), Arc::clone(partition)))
            .collect()
    }

    pub(super) fn forget_index(&self, index_name: &str) {
        lock(&self.held).retain(|key, partition| {
            let kept = key.0 != index_name;
            if !kept {
                lock(&partition.catch_up).cancel_feeds();
            }
            kept
        });
    }

    pub(super) fn forget_partition(&self, index_name: &str, partition_id: u32) {
        lock(&self.held).retain(|key, partition| {
            let kept = key.0 != index_name || key.1 != partition_id;
            if !kept {
                lock(&partition.catch_up).cancel_feeds();
            }
            kept
        });
    }
}
