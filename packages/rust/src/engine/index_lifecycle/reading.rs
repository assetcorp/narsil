use std::ops::Deref;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use super::residency::{IndexResidency, held};
use crate::engine::EngineInner;
use crate::engine::index::IndexState;
use crate::error::Result;

/// An open index that a read holds, which a restore waits for before it closes the index's files.
struct ReadingIndex {
    index: Arc<IndexState>,
}

impl ReadingIndex {
    fn enter(index: Arc<IndexState>) -> std::result::Result<ReadingIndex, Arc<IndexState>> {
        let residency = &index.residency;
        residency.active_reads.fetch_add(1, Ordering::SeqCst);
        if residency.swapping.load(Ordering::SeqCst) || index.is_retired() {
            residency.leave_read();
            return Err(index);
        }
        Ok(ReadingIndex { index })
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

    fn wait_for_swap(&self, index: &IndexState) {
        let mut turn = held(&self.turn);
        while self.swapping.load(Ordering::SeqCst) && !index.is_retired() {
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
    /// name afterwards.
    pub(crate) fn read_index<T>(
        &self,
        name: &str,
        read: impl FnOnce(&IndexState) -> Result<T>,
    ) -> Result<T> {
        self.read_index_prepared(name, |_| Ok(()), |index, ()| read(index))
    }

    /// Runs `prepare` on the index called `name` without holding it, then runs `read` on that same index with what
    /// `prepare` returned. Where a restore replaces the index in between, `prepare` runs again on the index that
    /// holds the name afterwards, so that a query embeds its text with the adapter of the index that it searches.
    pub(crate) fn read_index_prepared<P, T>(
        &self,
        name: &str,
        mut prepare: impl FnMut(&IndexState) -> Result<P>,
        read: impl FnOnce(&IndexState, P) -> Result<T>,
    ) -> Result<T> {
        loop {
            let index = self.open_index(name)?;
            let prepared = prepare(&index)?;
            match ReadingIndex::enter(index) {
                Ok(reading) => return read(&reading, prepared),
                Err(swapped) => swapped.residency.wait_for_swap(&swapped),
            }
        }
    }
}
