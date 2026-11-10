use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use crate::error::{NarsilError, Result};
use crate::format::envelope::Compression;
use crate::format::metadata::{IndexMetadata, write_metadata_file};

use super::checkpoint_files::metadata_key;
use super::log_segment::LogWrite;
use super::restore_journal::require_index_name;
use super::store_config::{Appended, DurabilityMode, StoreConfig};
use super::store_inner::{StoreInner, store_poisoned};

pub(crate) struct DurabilityStore {
    pub(crate) inner: Arc<StoreInner>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl DurabilityStore {
    pub(crate) fn open(config: StoreConfig) -> Result<DurabilityStore> {
        let (inner, thread) = StoreInner::start(config)?;
        Ok(DurabilityStore {
            inner,
            thread: Mutex::new(Some(thread)),
        })
    }

    pub(crate) fn fatal_error(&self) -> Option<NarsilError> {
        self.inner.fatal_error()
    }

    pub(crate) fn append(
        &self,
        index_name: &str,
        partition_id: u32,
        writes: Vec<LogWrite>,
    ) -> Result<Appended> {
        self.inner.require_healthy()?;
        let count = writes.len() as u64;
        let log = self.inner.log(index_name, partition_id)?;
        let (first_seq_no, last_seq_no) = log
            .append(&self.inner.directory, writes)
            .map_err(|error| self.inner.mark_fatal(error))?;
        self.inner
            .index_state(index_name)?
            .mutations
            .fetch_add(count, Ordering::Relaxed);
        Ok(Appended {
            first_seq_no,
            last_seq_no,
        })
    }

    pub(crate) fn wait_durable(
        &self,
        index_name: &str,
        partition_id: u32,
        seq_no: u64,
    ) -> Result<()> {
        self.inner.require_healthy()?;
        if self.inner.config.mode == DurabilityMode::Async {
            return Ok(());
        }
        let log = self.inner.log(index_name, partition_id)?;
        let verify = || self.inner.verify();
        self.inner
            .guard(log.flush_to(&self.inner.directory, seq_no, &verify))
    }

    pub(crate) fn checkpoint_due(&self, index_name: &str) -> Result<bool> {
        let state = self.inner.index_state(index_name)?;
        let mutations = state.mutations.load(Ordering::Relaxed);
        if mutations >= self.inner.config.checkpoint_mutation_threshold {
            return Ok(true);
        }
        let interval = self.inner.config.checkpoint_interval_ms;
        let elapsed = state
            .last_checkpoint
            .lock()
            .map_err(|_| store_poisoned())?
            .elapsed();
        Ok(mutations > 0 && interval > 0 && elapsed >= Duration::from_millis(interval))
    }

    pub(crate) fn write_metadata(&self, metadata: &IndexMetadata) -> Result<()> {
        self.inner.require_healthy()?;
        let state = self.inner.index_state(&metadata.index_name)?;
        let _turn = state.metadata_turn.lock().map_err(|_| store_poisoned())?;
        let bytes = write_metadata_file(metadata, Compression::None)?;
        let key = metadata_key(&metadata.index_name);
        self.inner
            .guard(self.inner.directory.write_atomic(&key, &[&bytes]))
    }

    pub(crate) fn remove_index(&self, index_name: &str) -> Result<()> {
        self.inner.require_healthy()?;
        require_index_name(index_name)?;
        self.inner.forget_index(index_name)?;
        let outcome = self.inner.directory.remove_tree(index_name);
        self.inner.guard(outcome)
    }

    pub(crate) fn close(&self) -> Result<()> {
        let thread = self.thread.lock().ok().and_then(|mut thread| thread.take());
        self.inner.shut_down(thread)
    }
}

impl Drop for DurabilityStore {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
