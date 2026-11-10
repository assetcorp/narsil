pub(crate) mod analysis;
pub(crate) mod drive;
pub(crate) mod rebuild;
pub(crate) mod switch;

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard};
use std::thread::ThreadId;

use super::constants::MAX_REBALANCE_QUEUED_WRITES;
use crate::error::{ErrorCode, NarsilError, Result};

/// The kind of work that rebuilds an index's partitions while the index keeps answering searches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ChangeKind {
    Rebalance,
    Analysis,
    Close,
}

struct RunningChange {
    kind: ChangeKind,
    owner: ThreadId,
    tracking: bool,
    written: HashSet<String>,
    queued: usize,
    stopped: bool,
}

#[derive(Default)]
struct Slot {
    running: Option<RunningChange>,
    latest_claim: u64,
}

/// The one change of an index's partitions that may run at a time, with the IDs of the documents that writes
/// touched while it ran, which the change applies to its new partitions before they replace the old ones.
#[derive(Default)]
pub(crate) struct LayoutChanges {
    slot: Mutex<Slot>,
    released: Condvar,
    tracking: AtomicBool,
    rebalance_target: AtomicUsize,
}

fn backpressure(message: String) -> NarsilError {
    NarsilError::new(ErrorCode::PARTITION_REBALANCING_BACKPRESSURE, message)
}

fn busy(kind: ChangeKind, running: ChangeKind, index_name: &str) -> NarsilError {
    match (kind, running) {
        (ChangeKind::Rebalance, ChangeKind::Rebalance) => backpressure(format!(
            "Index \"{index_name}\" is already being rebalanced"
        )),
        (ChangeKind::Rebalance, ChangeKind::Analysis) => backpressure(format!(
            "Index \"{index_name}\" is changing its analysis settings, so try the rebalance again once the change ends"
        )),
        (ChangeKind::Rebalance | ChangeKind::Close, ChangeKind::Close) => backpressure(format!(
            "Index \"{index_name}\" is closing, so try the rebalance again once it opens"
        )),
        (ChangeKind::Close, _) => backpressure(format!(
            "Index \"{index_name}\" is being rebalanced or changing its analysis settings on this thread, so a listener of that change cannot close it"
        )),
        (ChangeKind::Analysis, _) => backpressure(format!(
            "Index \"{index_name}\" is being rebalanced, so try its analysis change again once the rebalance ends"
        )),
    }
}

/// Returns the error that a change of an index's analysis ends with once a later change or a restore replaces it.
pub(crate) fn replaced(index_name: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::ANALYSIS_CHANGE_REPLACED,
        format!(
            "A later change or a restore replaced this analysis change of index \"{index_name}\""
        ),
    )
}

impl LayoutChanges {
    fn slot(&self) -> MutexGuard<'_, Slot> {
        self.slot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Claims the slot for a change of `kind`. A rebalance fails with `PARTITION_REBALANCING_BACKPRESSURE` while
    /// any change runs. An analysis change fails that way during a rebalance, and otherwise waits for the analysis
    /// change that runs. With `stops_running`, it first asks that change to stop, and fails with
    /// `ANALYSIS_CHANGE_REPLACED` where a later claim of that sort arrives while it waits.
    pub(crate) fn claim(
        &self,
        kind: ChangeKind,
        index_name: &str,
        stops_running: bool,
    ) -> Result<ChangeTicket<'_>> {
        let mut slot = self.slot();
        if let Some(running) = &slot.running
            && (kind == ChangeKind::Rebalance || running.kind == ChangeKind::Rebalance)
        {
            return Err(busy(kind, running.kind, index_name));
        }
        if stops_running {
            slot.latest_claim = slot.latest_claim.wrapping_add(1);
        }
        let claim = slot.latest_claim;
        let caller = std::thread::current().id();
        while let Some(running) = slot.running.as_mut() {
            if running.kind == ChangeKind::Rebalance {
                return Err(busy(kind, running.kind, index_name));
            }
            if running.owner == caller {
                return Err(NarsilError::new(
                    ErrorCode::ANALYSIS_CHANGE_NOT_READY,
                    format!(
                        "Index \"{index_name}\" is changing its analysis settings on this thread, so a listener of that change cannot start another"
                    ),
                ));
            }
            if stops_running {
                running.stopped = true;
            }
            slot = self
                .released
                .wait(slot)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if stops_running && slot.latest_claim != claim {
                return Err(replaced(index_name));
            }
        }
        slot.running = Some(RunningChange {
            kind,
            owner: caller,
            tracking: false,
            written: HashSet::new(),
            queued: 0,
            stopped: false,
        });
        Ok(ChangeTicket { changes: self })
    }

    /// Holds the slot for a close of the index once no change runs, so that no rebuild starts while the index
    /// closes. With `waits` false, returns `None` at once where a change runs. Fails with
    /// `PARTITION_REBALANCING_BACKPRESSURE` where the change that runs belongs to the calling thread, which a
    /// listener of that change would otherwise wait for forever.
    pub(crate) fn hold_for_close(
        &self,
        index_name: &str,
        waits: bool,
    ) -> Result<Option<ChangeTicket<'_>>> {
        let mut slot = self.slot();
        let caller = std::thread::current().id();
        while let Some(running) = slot.running.as_ref() {
            if running.owner == caller {
                return Err(busy(ChangeKind::Close, running.kind, index_name));
            }
            if !waits {
                return Ok(None);
            }
            slot = self
                .released
                .wait(slot)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        slot.running = Some(RunningChange {
            kind: ChangeKind::Close,
            owner: caller,
            tracking: false,
            written: HashSet::new(),
            queued: 0,
            stopped: false,
        });
        Ok(Some(ChangeTicket { changes: self }))
    }

    /// Reports whether a change of `kind` runs on the index.
    pub(crate) fn runs(&self, kind: ChangeKind) -> bool {
        self.slot()
            .running
            .as_ref()
            .is_some_and(|running| running.kind == kind)
    }

    /// Reports whether a rebalance runs on the index.
    pub(crate) fn is_rebalancing(&self) -> bool {
        self.runs(ChangeKind::Rebalance)
    }

    /// Returns the number of partitions that sets the index's capacity while it holds `current` partitions: the
    /// smaller of `current` and the target of a running rebalance, so that every write that the engine accepts
    /// fits the new partitions.
    pub(crate) fn capacity_partitions(&self, current: usize) -> usize {
        match self.rebalance_target.load(Ordering::Acquire) {
            0 => current,
            target => current.min(target),
        }
    }

    /// Records that a write touches `id`, while the writer holds the index's write lock and before the write
    /// applies. Fails with `PARTITION_REBALANCING_BACKPRESSURE` where a rebalance already holds the most writes
    /// that it queues.
    pub(crate) fn track_write(&self, id: &str) -> Result<()> {
        if !self.tracking.load(Ordering::Acquire) {
            return Ok(());
        }
        let mut slot = self.slot();
        let Some(running) = slot.running.as_mut().filter(|running| running.tracking) else {
            return Ok(());
        };
        if running.kind == ChangeKind::Rebalance && running.queued >= MAX_REBALANCE_QUEUED_WRITES {
            return Err(backpressure(format!(
                "Write-ahead queue is full ({MAX_REBALANCE_QUEUED_WRITES} entries). Retry after rebalancing completes."
            )));
        }
        running.queued += 1;
        running.written.insert(id.to_string());
        Ok(())
    }
}

/// The claim of one running change, which frees the slot when it drops.
pub(crate) struct ChangeTicket<'a> {
    changes: &'a LayoutChanges,
}

impl ChangeTicket<'_> {
    /// Records `target` as the partition count that the running rebalance moves the index to.
    pub(crate) fn set_rebalance_target(&self, target: usize) {
        self.changes
            .rebalance_target
            .store(target, Ordering::Release);
    }

    /// Starts recording the IDs that writes touch, while the caller holds the index's write lock.
    pub(crate) fn start_tracking(&self) {
        if let Some(running) = self.changes.slot().running.as_mut() {
            running.tracking = true;
        }
        self.changes.tracking.store(true, Ordering::Release);
    }

    /// Reports whether a later claim asked this change to stop.
    pub(crate) fn stopped(&self) -> bool {
        self.changes
            .slot()
            .running
            .as_ref()
            .is_some_and(|running| running.stopped)
    }

    /// Takes the IDs that writes touched since the last call, in no set order.
    pub(crate) fn drain(&self) -> Vec<String> {
        let mut slot = self.changes.slot();
        let Some(running) = slot.running.as_mut() else {
            return Vec::new();
        };
        running.queued = 0;
        std::mem::take(&mut running.written).into_iter().collect()
    }
}

impl Drop for ChangeTicket<'_> {
    fn drop(&mut self) {
        self.changes.tracking.store(false, Ordering::Release);
        self.changes.rebalance_target.store(0, Ordering::Release);
        self.changes.slot().running = None;
        self.changes.released.notify_all();
    }
}
