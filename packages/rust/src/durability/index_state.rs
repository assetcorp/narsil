use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;

use crate::error::{ErrorCode, NarsilError, Result};

pub(crate) fn index_poisoned() -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_SAVE_FAILED,
        "A thread failed while it held the durable state of an index",
    )
}

#[derive(Default)]
pub(crate) struct CheckpointTurn {
    busy: Mutex<bool>,
    released: Condvar,
}

impl CheckpointTurn {
    pub(crate) fn take(&self) -> Result<()> {
        let mut busy = self.busy.lock().map_err(|_| index_poisoned())?;
        while *busy {
            busy = self.released.wait(busy).map_err(|_| index_poisoned())?;
        }
        *busy = true;
        Ok(())
    }

    pub(crate) fn give_back(&self) {
        let mut busy = self
            .busy
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        *busy = false;
        self.released.notify_one();
    }
}

pub(crate) struct IndexState {
    pub(crate) checkpoint_turn: CheckpointTurn,
    pub(crate) metadata_turn: Mutex<()>,
    pub(crate) mutations: AtomicU64,
    pub(crate) last_checkpoint: Mutex<Instant>,
    pub(crate) pins: Mutex<HashMap<String, usize>>,
    pub(crate) records_previous_documents: Arc<AtomicBool>,
    replacements: AtomicU64,
    history_moved: AtomicBool,
}

impl IndexState {
    pub(crate) fn new() -> IndexState {
        IndexState {
            checkpoint_turn: CheckpointTurn::default(),
            metadata_turn: Mutex::new(()),
            mutations: AtomicU64::new(0),
            last_checkpoint: Mutex::new(Instant::now()),
            pins: Mutex::new(HashMap::new()),
            records_previous_documents: Arc::new(AtomicBool::new(false)),
            replacements: AtomicU64::new(0),
            history_moved: AtomicBool::new(false),
        }
    }

    /// Records that a checkpoint moved log segments into the index's sync history, whose limits then need applying.
    pub(crate) fn note_history_moved(&self) {
        self.history_moved.store(true, Ordering::Release);
    }

    /// Reports whether a checkpoint moved log segments into history since the last call, and clears the record.
    pub(crate) fn take_history_moved(&self) -> bool {
        self.history_moved.swap(false, Ordering::AcqRel)
    }

    /// Records that a restore or a drop is about to replace or remove the index's files, before it touches any,
    /// so that a reader of pinned files learns that the files under their keys may no longer be the pinned ones.
    pub(crate) fn mark_replaced(&self) {
        self.replacements.fetch_add(1, Ordering::SeqCst);
    }

    /// Returns the number of times that a restore or a drop has replaced or removed the index's files.
    pub(crate) fn replacements(&self) -> u64 {
        self.replacements.load(Ordering::SeqCst)
    }

    pub(crate) fn pinned(&self) -> Result<HashMap<String, usize>> {
        Ok(self.pins.lock().map_err(|_| index_poisoned())?.clone())
    }

    pub(crate) fn pin(state: &Arc<IndexState>, keys: &[String]) -> Result<FilePins> {
        let mut pins = state.pins.lock().map_err(|_| index_poisoned())?;
        for key in keys {
            *pins.entry(key.clone()).or_insert(0) += 1;
        }
        Ok(FilePins {
            state: state.clone(),
            keys: keys.to_vec(),
        })
    }
}

pub(crate) struct FilePins {
    state: Arc<IndexState>,
    keys: Vec<String>,
}

impl FilePins {
    /// Returns the number of times that a restore or a drop has replaced or removed the pinned index's files.
    pub(crate) fn replacements(&self) -> u64 {
        self.state.replacements()
    }
}

impl Drop for FilePins {
    fn drop(&mut self) {
        let mut pins = self
            .state
            .pins
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        for key in &self.keys {
            if let Some(count) = pins.get_mut(key) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    pins.remove(key);
                }
            }
        }
    }
}
