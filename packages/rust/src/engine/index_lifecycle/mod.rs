mod close;
pub(crate) mod constants;
mod limits;
mod reopen;
pub(crate) mod residency;
mod sweep;

use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Instant;

use super::engine_config::LifecycleLimits;
use super::index::IndexState;
use super::name_turns::NameTurn;
use super::query_suggestions::stored_state::SuggestionState;
use super::{EngineInner, Narsil};
use crate::config::IndexConfig;
use crate::error::{ErrorCode, NarsilError, Result};
pub(crate) use close::close_index;
pub(crate) use limits::enforce_limits;
pub(crate) use reopen::reopen_index;
use residency::WritableIndex;
pub(crate) use sweep::Sweeper;

/// Whether an index answers calls from memory now, or waits on its files for the next call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndexResidencyState {
    /// The index is in memory.
    Open,
    /// The index is on its files alone, and the next call that reaches it opens it again.
    Closed,
    /// The index failed to open again five times in a row, so each call fails with the last error until
    /// [`Narsil::open_index`] tries again.
    ReopenFailed,
}

/// The facts that the engine keeps of a closed index, which a listing reports without opening it.
#[derive(Clone)]
pub(crate) struct ClosedIndex {
    pub(crate) config: Arc<IndexConfig>,
    pub(crate) document_count: u64,
    pub(crate) saved_bytes: Option<u64>,
    pub(crate) partition_count: usize,
    pub(crate) language: String,
    pub(crate) suggestions: Arc<SuggestionState>,
    pub(crate) sync_on: bool,
}

/// An index that the engine holds: the open one, or the facts of the closed one.
pub(crate) enum HeldIndex {
    Open(Arc<IndexState>),
    Closed(ClosedIndex),
}

/// One closed index of a listing, with its state and the number of times that the engine reopened it.
pub(crate) struct ClosedListing {
    pub(crate) name: String,
    pub(crate) closed: ClosedIndex,
    pub(crate) state: IndexResidencyState,
    pub(crate) reopen_count: u64,
}

/// The closed indexes of an engine, with the number of calls that wait behind the reopen of each name.
#[derive(Default)]
pub(crate) struct ClosedRegistry {
    pub(crate) entries: HashMap<String, ClosedEntry>,
    pub(crate) waiters: HashMap<String, usize>,
}

/// One closed index, with the state of the reopen that the next call starts.
pub(crate) struct ClosedEntry {
    pub(crate) closed: ClosedIndex,
    pub(crate) reopening: bool,
    pub(crate) failures: u32,
    pub(crate) retry_at: Option<Instant>,
    pub(crate) last_error: Option<NarsilError>,
    pub(crate) reopen_failed: bool,
    pub(crate) reopen_count: u64,
}

impl ClosedEntry {
    pub(crate) fn new(closed: ClosedIndex, reopen_count: u64) -> ClosedEntry {
        ClosedEntry {
            closed,
            reopening: false,
            failures: 0,
            retry_at: None,
            last_error: None,
            reopen_failed: false,
            reopen_count,
        }
    }
}

/// The closed indexes of an engine and the limits that close open ones.
///
/// An open index is in the engine's map of indexes and has no entry here, so a call on an open index reads no
/// lock of this registry; only a call that finds its index missing from that map looks here.
pub(crate) struct IndexLifecycle {
    pub(crate) limits: Option<LifecycleLimits>,
    epoch: Instant,
    closed: Mutex<ClosedRegistry>,
    pub(crate) changed: Condvar,
    pub(crate) sweeper: Sweeper,
}

impl IndexLifecycle {
    pub(crate) fn new(limits: Option<LifecycleLimits>) -> IndexLifecycle {
        IndexLifecycle {
            limits,
            epoch: Instant::now(),
            closed: Mutex::new(ClosedRegistry::default()),
            changed: Condvar::new(),
            sweeper: Sweeper::default(),
        }
    }

    /// Returns the milliseconds since the engine started, which each index's last access records.
    pub(crate) fn now_ms(&self) -> u64 {
        u64::try_from(self.epoch.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    fn tracks_access(&self) -> bool {
        self.limits.is_some()
    }

    /// Records that a call reached `index` now, where the engine tracks access.
    pub(crate) fn touch(&self, index: &IndexState) {
        if self.tracks_access() {
            index.residency.touch(self.now_ms());
        }
    }

    pub(crate) fn waiter_limit(&self) -> usize {
        self.limits
            .map_or(constants::DEFAULT_MAX_REOPEN_WAITERS, |limits| {
                limits.max_reopen_waiters
            })
    }

    pub(crate) fn registry(&self) -> MutexGuard<'_, ClosedRegistry> {
        self.closed
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Reports whether the engine holds a closed index under `name`.
    pub(crate) fn holds_closed(&self, name: &str) -> bool {
        self.registry().entries.contains_key(name)
    }

    /// Returns what the engine recorded about the closed index `name` when it closed, or `None` where no closed
    /// index holds the name.
    pub(crate) fn closed_index(&self, name: &str) -> Option<ClosedIndex> {
        self.registry()
            .entries
            .get(name)
            .map(|entry| entry.closed.clone())
    }

    /// Records `name` as closed, before the caller takes it out of the engine's map of indexes, so that a call
    /// that misses the index in that map always finds this entry.
    pub(crate) fn record_closed(&self, name: &str, entry: ClosedEntry) {
        self.registry().entries.insert(name.to_string(), entry);
    }

    /// Removes the entry of `name` where a restore or a drop has settled the name, and wakes every call that
    /// waited on it.
    pub(crate) fn forget(&self, name: &str) -> Option<ClosedEntry> {
        let removed = self.registry().entries.remove(name);
        self.changed.notify_all();
        removed
    }

    pub(crate) fn clear(&self) {
        self.registry().entries.clear();
        self.changed.notify_all();
    }
}

fn index_not_found(name: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::INDEX_NOT_FOUND,
        format!("Index \"{name}\" does not exist"),
    )
}

impl EngineInner {
    /// Refuses an insert or an update with `MEMORY_WRITE_BLOCKED` while process memory stays above the block
    /// fraction, after the shutdown and missing-index checks, which win over the refusal as in every Narsil engine.
    pub(crate) fn refuse_while_memory_full(&self, name: &str) -> Result<()> {
        let Err(refusal) = self.memory.refuse_while_full(name) else {
            return Ok(());
        };
        self.guard_shutdown()?;
        if !self.holds_index(name) {
            return Err(index_not_found(name));
        }
        Err(refusal)
    }

    /// Returns the open index called `name`, or the facts of the closed one, or `None` where the engine holds
    /// no index of that name.
    ///
    /// A reopen moves a name from the registry of closed indexes to the map of open ones under the registry's
    /// lock, so a call that misses the name in the map reads the map again under that lock.
    pub(crate) fn held_index(&self, name: &str) -> Option<HeldIndex> {
        if let Some(index) = self.open_index_named(name) {
            return Some(HeldIndex::Open(index));
        }
        let registry = self.lifecycle.registry();
        if let Some(entry) = registry.entries.get(name) {
            return Some(HeldIndex::Closed(entry.closed.clone()));
        }
        self.open_index_named(name).map(HeldIndex::Open)
    }

    /// Reports whether the engine holds an index called `name`, open or closed.
    pub(crate) fn holds_index(&self, name: &str) -> bool {
        self.held_index(name).is_some()
    }

    /// Returns every open index and every closed one as they stand at one moment, each name once and in no
    /// set order, reading both under the registry's lock so that a close or a reopen hides no name.
    pub(crate) fn held_indexes(&self) -> (Vec<Arc<IndexState>>, Vec<ClosedListing>) {
        let registry = self.lifecycle.registry();
        let open = self.index_list();
        let closed = registry
            .entries
            .iter()
            .filter(|(name, _)| !open.iter().any(|index| index.name == **name))
            .map(|(name, entry)| ClosedListing {
                name: name.clone(),
                closed: entry.closed.clone(),
                state: match entry.reopen_failed {
                    true => IndexResidencyState::ReopenFailed,
                    false => IndexResidencyState::Closed,
                },
                reopen_count: entry.reopen_count,
            })
            .collect();
        (open, closed)
    }

    /// Returns the index called `name`, opening it again from its files where a close left it there.
    pub(crate) fn reach_index(&self, name: &str) -> Result<Arc<IndexState>> {
        if let Some(index) = self.open_index_named(name) {
            self.lifecycle.touch(&index);
            return Ok(index);
        }
        if !self.holds_index(name) {
            return Err(index_not_found(name));
        }
        reopen_index(self, name, false)
    }

    /// Returns the index called `name` held as a write, which a close of the index waits for, opening the index
    /// again where a close left it on its files or closes it while the write waits.
    pub(crate) fn writable_index(&self, name: &str) -> Result<WritableIndex> {
        loop {
            let index = self.open_index(name)?;
            match WritableIndex::enter(index) {
                Ok(writable) => return Ok(writable),
                Err(closing) => closing
                    .residency
                    .wait_for_close(&closing, self.lifecycle.waiter_limit())?,
            }
        }
    }

    pub(crate) fn open_index_in_turn(&self, name: &str) -> Result<(NameTurn<'_>, Arc<IndexState>)> {
        loop {
            let index = self.open_index(name)?;
            let turn = self.names.take(name)?;
            if self
                .open_index_named(name)
                .is_some_and(|current| Arc::ptr_eq(&current, &index))
            {
                return Ok((turn, index));
            }
        }
    }

    /// Runs `call` on the index called `name`, and runs it again on the index that took the name where a close
    /// or a restore retired the index while the call ran.
    pub(crate) fn on_current_index<T>(
        &self,
        name: &str,
        mut call: impl FnMut(&Arc<IndexState>) -> Result<T>,
    ) -> Result<T> {
        let mut attempt = 1;
        loop {
            let index = self.open_index(name)?;
            let outcome = call(&index);
            if outcome.is_err()
                && index.is_retired()
                && attempt < super::constants::MAX_REPLACED_WRITE_ATTEMPTS
            {
                attempt += 1;
                continue;
            }
            return outcome;
        }
    }
}

impl Narsil {
    /// Opens the index called `name` from its files where a close or an idle timeout left it there, and clears
    /// a parked reopen failure, so that the open tries again at once.
    ///
    /// An open index returns at once. Fails with `INDEX_NOT_FOUND` where the engine holds no index of that name,
    /// with `INDEX_REOPEN_CAPACITY_EXHAUSTED` where the most callers that the lifecycle settings allow already
    /// wait behind its reopen, and with the error that recovery raises where a stored file is damaged.
    pub fn open_index(&self, name: &str) -> Result<()> {
        let engine = &*self.inner;
        engine.guard_shutdown()?;
        if !engine.holds_index(name) {
            return Err(index_not_found(name));
        }
        let index = reopen_index(engine, name, true)?;
        engine.lifecycle.touch(&index);
        enforce_limits(engine, Some(name));
        Ok(())
    }

    /// Closes the index called `name`: waits for the writes and the rebuild that run on it, writes a checkpoint
    /// of it, releases its memory, and keeps its files, so that the next call that reaches it opens it again.
    ///
    /// A search that runs while the index closes reads the index as it stood, and a write that arrives while it
    /// closes waits, then applies to the index once it opens again. A closed index returns at once. Fails with
    /// `INDEX_NOT_FOUND` where the engine holds no index of that name, with `CONFIG_INVALID` for an engine
    /// without durability, and with `PERSISTENCE_SAVE_FAILED` where the checkpoint fails, which leaves the index
    /// open.
    pub fn close_index(&self, name: &str) -> Result<()> {
        close_index(&self.inner, name, false).map(|_| ())
    }
}
