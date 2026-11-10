use std::sync::Arc;

use super::Durable;
use super::backing::Backing;
use super::build::recovery_failure;
use super::checkpoint::write_checkpoint_locked;
use super::metadata::config_of;
use super::recover::recover_index;
use crate::durability::checkpoint_files::metadata_key;
use crate::engine::EngineInner;
use crate::engine::index::IndexState;
use crate::engine::index_lifecycle::{ClosedEntry, ClosedIndex};
use crate::engine::query_suggestions::state::SuggestionState;
use crate::engine::sync::sync_is_on;
use crate::error::Result;
use crate::format::envelope::MAX_FILE_BYTES;
use crate::format::metadata::read_metadata_file;

impl Durable {
    /// Loads the stored index `name` from its newest checkpoint and the log records that follow it, as recovery
    /// at startup loads it.
    pub(crate) fn reopen_index(
        &self,
        engine: &EngineInner,
        name: &str,
    ) -> Result<Option<Arc<IndexState>>> {
        recover_index(engine, &self.backing, self.compaction_threshold, name)
    }

    /// Writes a checkpoint of `index` while the caller holds its write lock, so that the checkpoint holds every
    /// write that the engine acknowledged before the close.
    pub(crate) fn checkpoint_for_close(&self, index: &IndexState) -> Result<()> {
        match index.log() {
            Some(log) => write_checkpoint_locked(index, log, None),
            None => Ok(()),
        }
    }

    /// Flushes and closes the write-ahead log files of `name`, which the next reopen registers again.
    pub(crate) fn release_logs(&self, name: &str) -> Result<()> {
        match &self.backing {
            Backing::Log(store) => store.inner.close_index_logs(name),
            Backing::Snapshot(_) => Ok(()),
        }
    }

    /// Records every stored index as closed from its metadata file alone, without loading its documents, then
    /// starts the checkpoint thread; the first call that reaches an index loads it.
    pub(crate) fn recover_closed(&self, engine: &Arc<EngineInner>) -> Result<()> {
        let files = self.backing.files();
        for name in self.backing.index_names()? {
            let Some(bytes) = files.read_within(&metadata_key(&name), MAX_FILE_BYTES)? else {
                continue;
            };
            let (_, metadata) = read_metadata_file(&bytes)?;
            let config = config_of(&metadata)?;
            let closed = ClosedIndex {
                config: Arc::new(config),
                document_count: metadata.document_count.unwrap_or(0),
                partition_count: usize::try_from(metadata.partition_count).unwrap_or(usize::MAX),
                language: metadata.language.clone(),
                suggestions: Arc::new(
                    SuggestionState::from_metadata(&metadata)
                        .map_err(|error| recovery_failure(&name, error))?,
                ),
                sync_on: sync_is_on(&metadata),
            };
            engine
                .lifecycle
                .record_closed(&name, ClosedEntry::new(closed, 0));
        }
        self.schedule.start(engine);
        Ok(())
    }
}
