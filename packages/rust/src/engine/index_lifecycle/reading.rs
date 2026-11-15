use std::ops::Deref;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use super::ClosedListing;
use super::residency::{IndexResidency, held};
use crate::engine::EngineInner;
use crate::engine::callback_scope::{self, CallbackScope};
use crate::engine::index::IndexState;
use crate::error::Result;

/// What a call works out about an index before it reads the index, which the read checks again once it holds it.
pub(crate) trait PreparedRead {
    /// Reports whether what the call worked out still holds for `index`, which a read holds now.
    fn holds_for(&self, index: &IndexState) -> bool;

    /// Marks what the call worked out as superseded, once a read has found that it no longer holds, so that the
    /// call works it out again in place of reusing it.
    fn supersede(&mut self);
}

/// An open index that a read holds, which a restore or a shutdown waits for before it closes the index's files.
struct ReadingIndex {
    index: Arc<IndexState>,
    _scope: CallbackScope,
    _held_on_thread: CallbackScope,
}

impl ReadingIndex {
    /// Holds `index` as a read, or returns it where a swap holds the reads that reach it. A read that a callback
    /// starts on a thread that already holds `index` enters during a swap too, because the swap waits for the
    /// read that runs the callback, which keeps the files open until both reads leave.
    fn enter(
        engine: &EngineInner,
        index: Arc<IndexState>,
    ) -> std::result::Result<ReadingIndex, Arc<IndexState>> {
        let residency = &index.residency;
        residency.active_reads.fetch_add(1, Ordering::SeqCst);
        let held_on_thread = callback_scope::dispatching_on_current_thread(&*index);
        if (residency.swapping.load(Ordering::SeqCst) && !held_on_thread) || index.is_retired() {
            residency.leave_read();
            return Err(index);
        }
        let held_on_thread = CallbackScope::enter(&*index);
        Ok(ReadingIndex {
            index,
            _scope: CallbackScope::enter(&engine.lifecycle),
            _held_on_thread: held_on_thread,
        })
    }
}

impl Deref for ReadingIndex {
    type Target = IndexState;

    fn deref(&self) -> &IndexState {
        &self.index
    }
}

impl Drop for ReadingIndex {
    fn drop(&mut self) {
        self.index.residency.leave_read();
    }
}

impl IndexResidency {
    fn leave_read(&self) {
        self.active_reads.fetch_sub(1, Ordering::SeqCst);
        if self.swapping.load(Ordering::SeqCst) {
            let _turn = held(&self.turn);
            self.changed.notify_all();
        }
    }

    /// Holds every read that reaches the index from now on, and waits until each read that runs on it now has
    /// left, so that the caller can close the index's files while no read uses them.
    pub(crate) fn begin_swap(&self) {
        self.swapping.store(true, Ordering::SeqCst);
        let mut turn = held(&self.turn);
        while self.active_reads.load(Ordering::SeqCst) > 0 {
            turn = self
                .changed
                .wait(turn)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }

    /// Lets the reads that [`IndexResidency::begin_swap`] held go on, once the caller has retired the index, so
    /// that each one reads the index that holds the name afterwards.
    pub(crate) fn end_swap(&self) {
        let _turn = held(&self.turn);
        self.swapping.store(false, Ordering::SeqCst);
        self.changed.notify_all();
    }

    /// Waits until the swap of `index` ends or retires it, or until `shut_down` is set, because a shutdown that
    /// swaps the index waits for reads that can depend on the caller, and it retires the index regardless.
    fn wait_for_swap(&self, index: &IndexState, shut_down: &AtomicBool) {
        let mut turn = held(&self.turn);
        while self.swapping.load(Ordering::SeqCst)
            && !index.is_retired()
            && !shut_down.load(Ordering::Acquire)
        {
            turn = self
                .changed
                .wait(turn)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }
}

impl EngineInner {
    /// Runs `read` on the index called `name`, opening it again where a close left it on its files. A read that
    /// arrives while a restore swaps the index's files waits for the swap, then runs on the index that holds the
    /// name afterwards. A read that arrives while a shutdown swaps them fails with `INSTANCE_SHUT_DOWN` at once.
    pub(crate) fn read_index<T>(
        &self,
        name: &str,
        read: impl FnOnce(&IndexState) -> Result<T>,
    ) -> Result<T> {
        loop {
            let index = self.open_index(name)?;
            match ReadingIndex::enter(self, index) {
                Ok(reading) => return read(&reading),
                Err(swapped) => swapped.residency.wait_for_swap(&swapped, &self.shut_down),
            }
        }
    }

    /// Runs `list` on every open index and every closed index that the engine holds, holding each open one as a
    /// read does. Where a restore swaps the files of one of them, the listing waits for the swap and starts again,
    /// so that it reports the index before the restore or after it, never one whose files the restore closed.
    /// Where a shutdown has begun by then, `list` runs at once on no index, as it does once the shutdown ends.
    pub(crate) fn read_held_indexes<T>(
        &self,
        list: impl FnOnce(&[&IndexState], Vec<ClosedListing>) -> T,
    ) -> T {
        loop {
            if self.shut_down.load(Ordering::Acquire) {
                return list(&[], Vec::new());
            }
            let (open, closed) = self.held_indexes();
            let mut reading = Vec::with_capacity(open.len());
            let mut swapped = None;
            for index in open {
                match ReadingIndex::enter(self, index) {
                    Ok(held) => reading.push(held),
                    Err(index) => {
                        swapped = Some(index);
                        break;
                    }
                }
            }
            let Some(index) = swapped else {
                let held: Vec<&IndexState> = reading.iter().map(|held| &**held).collect();
                return list(&held, closed);
            };
            drop(reading);
            index.residency.wait_for_swap(&index, &self.shut_down);
        }
    }

    /// Runs `prepare` on the index called `name` without holding it, then runs `read` on that same index with what
    /// `prepare` returned, once the read holds the index and finds that what `prepare` returned still holds for it.
    /// `prepare` first runs given `earlier`, which a call that reads the index again passes on from its last read.
    /// Where a restore replaces the index in between, `prepare` runs again on the index that holds the name
    /// afterwards, given what it returned before, and where the read finds it superseded, `prepare` runs again
    /// given it marked as such, so that a query embeds its text with the adapter of the index that it searches.
    /// `prepare` never runs while a read holds an index, so an embedding adapter can restore the index that it
    /// embeds for, and `prepare` bounds how often it embeds again.
    pub(crate) fn read_index_prepared<P: PreparedRead, T>(
        &self,
        name: &str,
        mut earlier: Option<P>,
        mut prepare: impl FnMut(&IndexState, Option<P>) -> Result<P>,
        read: impl FnOnce(&Arc<IndexState>, P) -> Result<T>,
    ) -> Result<T> {
        loop {
            let index = self.open_index(name)?;
            let mut prepared = prepare(&index, earlier.take())?;
            match ReadingIndex::enter(self, index) {
                Ok(reading) if prepared.holds_for(&reading) => {
                    return read(&reading.index, prepared);
                }
                Ok(reading) => {
                    drop(reading);
                    prepared.supersede();
                }
                Err(swapped) => swapped.residency.wait_for_swap(&swapped, &self.shut_down),
            }
            earlier = Some(prepared);
        }
    }
}
