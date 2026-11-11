use super::Durable;
use super::backing::Backing;
use super::log::IndexLog;
use super::saved_size::SavedSize;
use crate::durability::restore::RestoreStaging;
use crate::error::Result;
use crate::format::manifest::SegmentManifest;
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
    /// which numbers each partition's writes after the restored checkpoint and reports the saved size of
    /// `manifest`.
    pub(crate) fn adopt_restore(
        &self,
        staging: &mut RestoreStaging<'_>,
        manifest: &SegmentManifest,
        metadata: IndexMetadata,
    ) -> Result<IndexLog> {
        let log = IndexLog::new(self.backing.clone(), metadata, self.compaction_threshold);
        log.record_saved(SavedSize::of(manifest));
        let checkpoint = &manifest.checkpoint;
        match &self.backing {
            Backing::Log(store) => store.adopt_restore(staging, checkpoint)?,
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
}
