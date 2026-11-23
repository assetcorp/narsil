use std::collections::{HashMap, HashSet};
use std::time::Duration;

use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::allocator::Table;

pub(super) type PartitionKey = (String, u32);

#[derive(Debug, Clone)]
pub(super) struct Tracked {
    pub(super) is_primary: bool,
    pub(super) primary_term: f64,
    pub(super) primary_node_id: Option<String>,
    pub(super) in_sync: bool,
}

pub(super) struct AwaitedAdmission {
    pub(super) id: u64,
    pub(super) primary_node_id: String,
    pub(super) primary_term: f64,
}

pub(super) struct BootstrapSlot {
    pub(super) id: u64,
    pub(super) abort: watch::Sender<bool>,
    pub(super) task: Option<JoinHandle<()>>,
}

impl BootstrapSlot {
    pub(super) fn abort(&self) {
        self.abort.send_replace(true);
    }
}

#[derive(Default)]
pub(super) struct WatcherState {
    pub(super) stopped: bool,
    pub(super) tracked: HashMap<PartitionKey, Tracked>,
    pub(super) unserved: HashSet<PartitionKey>,
    pub(super) bootstraps: HashMap<PartitionKey, BootstrapSlot>,
    pub(super) awaited: HashMap<PartitionKey, AwaitedAdmission>,
    pub(super) retained: HashSet<PartitionKey>,
    pub(super) seeded: HashSet<String>,
    pub(super) index_uuids: HashMap<String, String>,
    pub(super) pending: HashMap<String, Table>,
    pub(super) arrivals: Vec<Table>,
    pub(super) next_bootstrap_id: u64,
}

impl WatcherState {
    pub(super) fn abort_bootstrap(&mut self, key: &PartitionKey) {
        if let Some(slot) = self.bootstraps.remove(key) {
            slot.abort();
        }
    }

    pub(super) fn forget_awaited(&mut self, key: &PartitionKey) {
        self.awaited.remove(key);
    }
}

pub(super) enum Action {
    Bootstrap {
        key: PartitionKey,
        primary_node_id: String,
        primary_term: f64,
    },
    HoldPartition(PartitionKey),
    StartTerm {
        key: PartitionKey,
        primary_term: f64,
    },
    RemovePartition(PartitionKey),
    ReleaseTornDown(String),
}

#[derive(Clone)]
pub(super) struct Abort(watch::Receiver<bool>);

impl Abort {
    pub(super) fn new(receiver: watch::Receiver<bool>) -> Abort {
        Abort(receiver)
    }

    pub(super) fn is_aborted(&self) -> bool {
        *self.0.borrow() || self.0.has_changed().is_err()
    }

    pub(super) async fn pause(&mut self, delay_ms: u64) -> bool {
        if self.is_aborted() {
            return false;
        }
        let slept = tokio::select! {
            () = tokio::time::sleep(Duration::from_millis(delay_ms)) => true,
            _ = self.0.wait_for(|aborted| *aborted) => false,
        };
        slept && !self.is_aborted()
    }

    pub(super) async fn unless_aborted<F: Future>(&mut self, work: F) -> Option<F::Output> {
        if self.is_aborted() {
            return None;
        }
        let output = tokio::select! {
            output = work => Some(output),
            _ = self.0.wait_for(|aborted| *aborted) => None,
        };
        output.filter(|_| !self.is_aborted())
    }
}
