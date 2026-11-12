use std::ops::Deref;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};

use crate::engine::index::IndexState;
use crate::error::{ErrorCode, NarsilError, Result};

/// The lifecycle facts of one open index: the writes and the reads that run on it now, whether a close is draining
/// the writes or a restore is draining the reads, when a call last reached it, and how many times the engine has
/// opened it again after a close.
#[derive(Default)]
pub(crate) struct IndexResidency {
    active_writes: AtomicUsize,
    pub(super) active_reads: AtomicUsize,
    closing: AtomicBool,
    pub(super) swapping: AtomicBool,
    last_access_ms: AtomicU64,
    reopen_count: AtomicU64,
    waiters: AtomicUsize,
    pub(super) turn: Mutex<()>,
    pub(super) changed: Condvar,
}

pub(super) fn held(turn: &Mutex<()>) -> MutexGuard<'_, ()> {
    turn.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl IndexResidency {
    pub(crate) fn last_access_ms(&self) -> u64 {
        self.last_access_ms.load(Ordering::Relaxed)
    }

    pub(crate) fn touch(&self, now_ms: u64) {
        self.last_access_ms.store(now_ms, Ordering::Relaxed);
    }

    pub(crate) fn reopen_count(&self) -> u64 {
        self.reopen_count.load(Ordering::Relaxed)
    }

    pub(crate) fn set_reopen_count(&self, count: u64) {
        self.reopen_count.store(count, Ordering::Relaxed);
    }

    pub(crate) fn active_writes(&self) -> usize {
        self.active_writes.load(Ordering::SeqCst)
    }

    fn is_closing(&self) -> bool {
        self.closing.load(Ordering::SeqCst)
    }

    /// Marks the index as closing, so that each later write waits for the close to settle.
    pub(crate) fn begin_close(&self) {
        self.closing.store(true, Ordering::SeqCst);
    }

    /// Clears the closing mark of a close that failed or gave way, and wakes every write that waited for it.
    pub(crate) fn abandon_close(&self) {
        let _turn = held(&self.turn);
        self.closing.store(false, Ordering::SeqCst);
        self.changed.notify_all();
    }

    /// Wakes every write that waited for the close, once the close has retired the index.
    pub(crate) fn finish_close(&self) {
        let _turn = held(&self.turn);
        self.changed.notify_all();
    }

    /// Waits until every write that entered before the close began has left.
    pub(crate) fn wait_for_writes(&self) {
        let mut turn = held(&self.turn);
        while self.active_writes() > 0 {
            turn = self
                .changed
                .wait(turn)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }

    /// Waits for the close of `index` to settle, counting the caller among the waiters, and fails with
    /// `INDEX_REOPEN_CAPACITY_EXHAUSTED` where `limit` callers already wait.
    pub(crate) fn wait_for_close(&self, index: &IndexState, limit: usize) -> Result<()> {
        let mut turn = held(&self.turn);
        if !self.is_closing() || index.is_retired() {
            return Ok(());
        }
        if self.waiters.load(Ordering::SeqCst) >= limit {
            return Err(waiters_exhausted(&index.name, limit));
        }
        self.waiters.fetch_add(1, Ordering::SeqCst);
        while self.is_closing() && !index.is_retired() {
            turn = self
                .changed
                .wait(turn)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        self.waiters.fetch_sub(1, Ordering::SeqCst);
        Ok(())
    }
}

/// Returns the error of a call that found the most callers that may wait behind one close or reopen.
pub(crate) fn waiters_exhausted(index_name: &str, limit: usize) -> NarsilError {
    NarsilError::new(
        ErrorCode::INDEX_REOPEN_CAPACITY_EXHAUSTED,
        format!("Index \"{index_name}\" has reached its reopen waiter limit of {limit}"),
    )
}

/// An open index that a write holds, which a close of the index waits for before it checkpoints.
pub(crate) struct WritableIndex {
    index: Arc<IndexState>,
}

impl WritableIndex {
    /// Enters `index` as a write, or returns `None` where a close of the index has begun.
    pub(crate) fn enter(
        index: Arc<IndexState>,
    ) -> std::result::Result<WritableIndex, Arc<IndexState>> {
        let residency = &index.residency;
        residency.active_writes.fetch_add(1, Ordering::SeqCst);
        if residency.closing.load(Ordering::SeqCst) {
            leave(residency);
            return Err(index);
        }
        Ok(WritableIndex { index })
    }

    pub(crate) fn index(&self) -> &Arc<IndexState> {
        &self.index
    }
}

fn leave(residency: &IndexResidency) {
    residency.active_writes.fetch_sub(1, Ordering::SeqCst);
    if residency.closing.load(Ordering::SeqCst) {
        let _turn = held(&residency.turn);
        residency.changed.notify_all();
    }
}

impl Deref for WritableIndex {
    type Target = IndexState;

    fn deref(&self) -> &IndexState {
        &self.index
    }
}

impl Drop for WritableIndex {
    fn drop(&mut self) {
        leave(&self.index.residency);
    }
}
