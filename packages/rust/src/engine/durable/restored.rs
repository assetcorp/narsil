use super::Durable;
use super::backing::Backing;
use super::load::load_partitions;
use super::log::IndexLog;
use crate::durability::restore::RestoreStaging;
use crate::engine::index::IndexState;
use crate::error::Result;
use crate::format::manifest::{PartitionCheckpoint, SegmentManifest};
use crate::format::metadata::IndexMetadata;

impl Durable {
    /// Starts a restore of `index_name` in the engine's store, whose files stay apart from the index's files
    /// until the restore commits.
    pub(crate) fn begin_restore(&self, index_name: &str) -> Result<RestoreStaging<'_>> {
        match &self.backing {
            Backing::Log(store) => store.begin_restore(index_name),
            Backing::Snapshot(store) => store.begin_restore(index_name),
        }
    }

    /// Moves a staged restore into the index's place, and returns the log that the restored index writes to,
    /// which numbers each partition's writes after the restored checkpoint. A store that keeps a directory of
    /// files calls `release_files` once the journal commits and before it moves any file.
    pub(crate) fn adopt_restore(
        &self,
        staging: &mut RestoreStaging<'_>,
        checkpoint: &[PartitionCheckpoint],
        metadata: IndexMetadata,
        release_files: &mut dyn FnMut(),
    ) -> Result<IndexLog> {
        let log = IndexLog::new(self.backing.clone(), metadata, self.compaction_threshold);
        match &self.backing {
            Backing::Log(store) => store.adopt_restore(staging, checkpoint, release_files)?,
            Backing::Snapshot(store) => {
                store.adopt_restore(staging)?;
                let reached: Vec<(u32, u64)> = checkpoint
                    .iter()
                    .map(|entry| (entry.partition_id, entry.last_seq_no))
                    .collect();
                log.resume_after(&reached);
            }
        }
        Ok(log)
    }

    /// Loads the restored index's segments from the files that the restore moved into the index's place. A failure
    /// marks the store failed, because the store has committed the restore and only a restart can load it.
    pub(crate) fn load_restored_segments(
        &self,
        index: &IndexState,
        manifest: &SegmentManifest,
    ) -> Result<()> {
        load_partitions(&self.backing, index, manifest).map_err(|error| match &self.backing {
            Backing::Log(store) => store.inner.mark_fatal(error),
            Backing::Snapshot(_) => error,
        })
    }
}
