use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Instant;

use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::layout::manifest_key;
use crate::format::manifest::{PartitionCheckpoint, SegmentManifest};
use crate::format::metadata::IndexMetadata;

use super::checkpoint_files::{metadata_key, pack_commit};
use super::checkpoint_store::{CheckpointStore, FileLength, FileSink};
use super::constants::SINGLE_NODE_PRIMARY_TERM;
use super::index_state::IndexState;
use super::log_segment::LogStart;
use super::restore_journal::{
    RESTORE_STAGING_PREFIX, RestoreStorage, finish_journal, journal_key, require_index_name,
    unique_name,
};
use super::snapshot_only::SnapshotStore;
use super::store::DurabilityStore;

/// The files of one restore, which a store keeps under a staging prefix until the restore commits, addressed by
/// the keys that they take once they belong to the index.
pub(crate) struct RestoreStaging<'d> {
    storage: &'d dyn RestoreStorage,
    index_name: String,
    staging: String,
    committed: bool,
    retired: Option<String>,
}

impl<'d> RestoreStaging<'d> {
    pub(crate) fn create(
        storage: &'d dyn RestoreStorage,
        index_name: &str,
    ) -> Result<RestoreStaging<'d>> {
        Ok(RestoreStaging {
            storage,
            index_name: index_name.to_string(),
            staging: unique_name(RESTORE_STAGING_PREFIX, "the staging directory of a restore")?,
            committed: false,
            retired: None,
        })
    }

    fn staged(&self, key: &str) -> Result<String> {
        match key
            .strip_prefix(&self.index_name)
            .and_then(|tail| tail.strip_prefix('/'))
        {
            Some(relative) => Ok(format!("{}/{relative}", self.staging)),
            None => Err(NarsilError::new(
                ErrorCode::PERSISTENCE_SAVE_FAILED,
                format!(
                    "A restore of \"{}\" cannot stage \"{key}\"",
                    self.index_name
                ),
            )),
        }
    }

    pub(crate) fn index_name(&self) -> &str {
        &self.index_name
    }

    fn committed(&self) -> bool {
        self.committed
    }

    pub(crate) fn commit(&mut self) -> Result<()> {
        let journal = format!("{}\n{}/", self.index_name, self.staging);
        let key = journal_key(&self.index_name);
        let store = self.storage.store();
        if let Err(error) = store.write_commit(&key, journal.as_bytes()) {
            if store.remove(&key).is_err() {
                self.committed = true;
            }
            return Err(error);
        }
        self.committed = true;
        Ok(())
    }

    pub(crate) fn finish(&mut self) -> Result<()> {
        self.retired = finish_journal(self.storage, &self.index_name, &self.staging)?;
        Ok(())
    }

    pub(crate) fn remove_retired(&mut self) -> Result<()> {
        match self.retired.take() {
            Some(retired) => self.storage.remove_prefix(&retired),
            None => Ok(()),
        }
    }

    pub(crate) fn discard(&self) -> Result<()> {
        if self.committed {
            return Ok(());
        }
        self.storage.remove_prefix(&self.staging)
    }

    /// Writes the manifest and the metadata of the restored index beside the files that the restore staged.
    pub(crate) fn stage_commit(
        &self,
        manifest: &SegmentManifest,
        metadata: &IndexMetadata,
    ) -> Result<()> {
        let packed = pack_commit(&self.index_name, manifest, metadata)?;
        let store = self.storage.store();
        store.write_commit(
            &self.staged(&manifest_key(&self.index_name))?,
            &packed.manifest,
        )?;
        store.write_commit(
            &self.staged(&metadata_key(&self.index_name))?,
            &packed.metadata,
        )
    }
}

impl CheckpointStore for RestoreStaging<'_> {
    fn read_within(&self, key: &str, limit: u64) -> Result<Option<Vec<u8>>> {
        self.storage.store().read_within(&self.staged(key)?, limit)
    }

    fn read_range(&self, key: &str, offset: u64, length: u64) -> Result<Vec<u8>> {
        self.storage
            .store()
            .read_range(&self.staged(key)?, offset, length)
    }

    fn length(&self, key: &str) -> Result<FileLength> {
        self.storage.store().length(&self.staged(key)?)
    }

    fn begin_file(&self, key: &str) -> Result<FileSink> {
        self.storage.store().begin_file(&self.staged(key)?)
    }

    fn finish_file(&self, sink: FileSink) -> Result<Option<PathBuf>> {
        self.storage.store().finish_file(sink)
    }

    fn sync_directories(&self, directories: &[PathBuf]) -> Result<()> {
        self.storage.store().sync_directories(directories)
    }

    fn write_commit(&self, key: &str, bytes: &[u8]) -> Result<()> {
        self.storage.store().write_commit(&self.staged(key)?, bytes)
    }

    fn remove(&self, key: &str) -> Result<()> {
        self.storage.store().remove(&self.staged(key)?)
    }

    fn list(&self, prefix: &str) -> Result<Vec<String>> {
        let staged_prefix = self.staged(prefix)?;
        let root = format!("{}/", self.index_name);
        let staging_root = format!("{}/", self.staging);
        Ok(self
            .storage
            .store()
            .list(&staged_prefix)?
            .into_iter()
            .filter_map(|key| {
                key.strip_prefix(&staging_root)
                    .map(|relative| format!("{root}{relative}"))
            })
            .collect())
    }
}

fn in_turn<T>(state: &IndexState, work: impl FnOnce() -> Result<T>) -> Result<T> {
    state.checkpoint_turn.take()?;
    let outcome = work();
    state.checkpoint_turn.give_back();
    outcome
}

fn restart_count(state: &IndexState) {
    state.mutations.store(0, Ordering::Relaxed);
    if let Ok(mut last) = state.last_checkpoint.lock() {
        *last = Instant::now();
    }
}

/// Commits a staged restore while the index's checkpoint turn is held: writes the journal that makes the swap
/// survive a crash, then moves the staged files into the index's place. A failure before the journal leaves the
/// old index's files whole; a failure after it goes to `lost`, because only a restart can finish the swap.
fn commit_staged(
    staging: &mut RestoreStaging<'_>,
    before_swap: impl FnOnce() -> Result<()>,
    lost: &dyn Fn(NarsilError) -> NarsilError,
) -> Result<()> {
    if let Err(error) = staging.commit() {
        return Err(if staging.committed() {
            lost(error)
        } else {
            error
        });
    }
    before_swap().map_err(lost)?;
    staging.finish().map_err(lost)
}

impl DurabilityStore {
    /// Starts a restore of `index_name`, whose files go to a staging directory until the restore commits.
    pub(crate) fn begin_restore(&self, index_name: &str) -> Result<RestoreStaging<'_>> {
        self.inner.verify()?;
        require_index_name(index_name)?;
        RestoreStaging::create(&self.inner.directory, index_name)
    }

    /// Moves a staged restore into the index's place and starts each partition's log after the restored
    /// checkpoint, closing the old index's logs first.
    pub(crate) fn adopt_restore(
        &self,
        staging: &mut RestoreStaging<'_>,
        checkpoint: &[PartitionCheckpoint],
    ) -> Result<()> {
        let inner = &self.inner;
        let index_name = staging.index_name().to_string();
        let state = inner.index_state(&index_name)?;
        inner.commit_restore(|| {
            in_turn(&state, || {
                let lost = |error| inner.mark_fatal(error);
                state.mark_replaced();
                commit_staged(staging, || inner.close_index_logs(&index_name), &lost)?;
                for partition in checkpoint {
                    let start = LogStart {
                        active: None,
                        highest_seq_no: partition.last_seq_no,
                        highest_durable_seq_no: partition.last_seq_no,
                        primary_term: partition.primary_term.max(SINGLE_NODE_PRIMARY_TERM),
                    };
                    inner
                        .register_log(&index_name, partition.partition_id, start)
                        .map_err(lost)?;
                }
                restart_count(&state);
                Ok(())
            })
        })
    }
}

impl SnapshotStore {
    /// Starts a restore of `index_name`, whose files go under a staging prefix until the restore commits.
    pub(crate) fn begin_restore(&self, index_name: &str) -> Result<RestoreStaging<'_>> {
        require_index_name(index_name)?;
        RestoreStaging::create(self.store(), index_name)
    }

    /// Moves a staged restore into the index's place.
    pub(crate) fn adopt_restore(&self, staging: &mut RestoreStaging<'_>) -> Result<()> {
        let state = self.index_state(staging.index_name())?;
        in_turn(&state, || {
            state.mark_replaced();
            commit_staged(staging, || Ok(()), &|error| error)?;
            restart_count(&state);
            Ok(())
        })
    }
}
