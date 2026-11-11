pub(crate) mod archive;
mod backing;
mod build;
mod bundle;
mod checkpoint;
mod checkpoint_positions;
mod checkpoint_segments;
mod checkpoint_vectors;
mod compaction;
pub(crate) mod config;
pub(crate) mod constants;
mod earlier;
pub(crate) mod load;
mod load_from_files;
pub(crate) mod load_source;
pub(crate) mod log;
pub(crate) mod metadata;
mod recover;
mod removed_documents;
mod residency;
mod restored;
pub(crate) mod saved_size;
mod schedule;
pub(crate) mod switch;

use std::sync::Arc;

use crate::durability::constants::{
    DEFAULT_CHECKPOINT_INTERVAL_MS, DEFAULT_CHECKPOINT_MUTATION_THRESHOLD,
    DEFAULT_COMPACTION_THRESHOLD,
};
use crate::durability::snapshot_only::SnapshotStore;
use crate::durability::store::DurabilityStore;
use crate::engine::EngineInner;
use crate::engine::index::IndexState;
use crate::error::Result;
use backing::Backing;
use config::{LogTier, SnapshotTier};
use log::IndexLog;
use metadata::created_metadata;
use schedule::CheckpointSchedule;

/// The store of a durable engine, which every durable index of the engine writes to, and the thread that writes
/// their checkpoints.
pub(crate) struct Durable {
    backing: Backing,
    compaction_threshold: u32,
    schedule: CheckpointSchedule,
}

impl Durable {
    /// Opens the log tier's directory, taking the directory's lock.
    pub(crate) fn open_log(tier: LogTier) -> Result<Durable> {
        let schedule = CheckpointSchedule::new(
            tier.store.checkpoint_interval_ms,
            tier.store.checkpoint_mutation_threshold,
        );
        Ok(Durable {
            backing: Backing::Log(Arc::new(DurabilityStore::open(tier.store)?)),
            compaction_threshold: tier.compaction_threshold,
            schedule,
        })
    }

    /// Opens the snapshot tier's persistence adapter, finishing any restore that a crash interrupted.
    pub(crate) fn open_snapshot(tier: SnapshotTier) -> Result<Durable> {
        let schedule = CheckpointSchedule::new(
            tier.checkpoint_interval_ms
                .unwrap_or(DEFAULT_CHECKPOINT_INTERVAL_MS),
            tier.checkpoint_mutation_threshold
                .unwrap_or(DEFAULT_CHECKPOINT_MUTATION_THRESHOLD),
        );
        Ok(Durable {
            backing: Backing::Snapshot(Arc::new(SnapshotStore::open(tier.adapter)?)),
            compaction_threshold: DEFAULT_COMPACTION_THRESHOLD,
            schedule,
        })
    }

    /// Returns the store that holds every file of the engine.
    pub(crate) fn files(&self) -> &dyn crate::durability::checkpoint_store::CheckpointStore {
        self.backing.files()
    }

    /// Reports whether the engine keeps its files in a directory, which disk-backed storage reads from.
    pub(crate) fn holds_directory(&self) -> bool {
        matches!(self.backing, Backing::Log(_))
    }

    /// Recovers every index that the store holds into `engine`, then starts the checkpoint thread.
    pub(crate) fn recover(&self, engine: &Arc<EngineInner>) -> Result<()> {
        recover::recover_indexes(engine, &self.backing, self.compaction_threshold)?;
        self.schedule.start(engine);
        Ok(())
    }

    /// Writes the metadata file of a new index and gives the index its log, before any document reaches it.
    pub(crate) fn attach_created(&self, index: &IndexState) -> Result<()> {
        let recorded = created_metadata(&index.name, index.analyser().language());
        let log = IndexLog::new(self.backing.clone(), recorded, self.compaction_threshold);
        log.write_metadata(index)?;
        index.attach_log(log);
        Ok(())
    }

    /// Removes every file of a dropped index.
    pub(crate) fn remove_index(&self, name: &str) -> Result<()> {
        self.backing.remove_index(name)
    }

    /// Wakes the checkpoint thread where a write has made a checkpoint of `index` due.
    pub(crate) fn after_write(&self, index: &IndexState) {
        self.schedule.after_write(index);
    }

    /// Wakes the checkpoint thread for one pass, after a checkpoint that another thread wrote.
    pub(crate) fn request_pass(&self) {
        self.schedule.request_pass();
    }

    /// Stops the checkpoint thread, flushes every log, and releases the directory.
    pub(crate) fn close(&self) -> Result<()> {
        self.schedule.stop();
        match &self.backing {
            Backing::Log(store) => store.close(),
            Backing::Snapshot(_) => Ok(()),
        }
    }
}

impl Drop for Durable {
    fn drop(&mut self) {
        self.schedule.stop();
    }
}

/// Writes a checkpoint of a durable index now.
pub(crate) fn checkpoint_now(index: &IndexState) -> Result<()> {
    match index.log() {
        Some(log) => checkpoint::write_checkpoint(index, log, None),
        None => Ok(()),
    }
}
