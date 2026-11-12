use std::sync::Arc;

use crate::config::Storage;
use crate::durability::restore::RestoreStaging;
use crate::engine::EngineInner;
use crate::engine::durable::Durable;
use crate::engine::durable::log::IndexLog;
use crate::engine::durable::saved_size::SavedSize;
use crate::engine::index::IndexState;
use crate::engine::index_lifecycle::{ClosedEntry, ClosedIndex, closed_facts};
use crate::error::Result;
use crate::format::manifest::SegmentManifest;
use crate::format::metadata::IndexMetadata;

/// The restore of one durable index whose files a directory keeps: the index that the restore loaded, the open
/// index that it replaces, and the store that moves the files.
pub(super) struct FileSwap<'a> {
    pub(super) engine: &'a EngineInner,
    pub(super) durable: &'a Durable,
    pub(super) restored: &'a IndexState,
    pub(super) previous: Option<&'a Arc<IndexState>>,
    pub(super) manifest: &'a SegmentManifest,
}

impl FileSwap<'_> {
    fn reopens_text(&self) -> bool {
        self.durable.holds_directory() && self.restored.config().text_storage == Some(Storage::Disk)
    }

    /// Closes every file that the open index and the restored one read, while the caller holds the open index's
    /// write lock: holds each read that reaches the open index until the swap ends and waits for those that run,
    /// then drops the open index's segments and vectors and the restored index's paged segments.
    fn release_files(&self) {
        if let Some(previous) = self.previous {
            previous.residency.begin_swap();
            previous.empty_partitions();
            previous.vectors.release_files();
        }
        if self.reopens_text() {
            self.restored.empty_partitions();
        }
    }

    /// Takes the index called `name` out of the engine and records it as closed on its files, so that the next
    /// call that reaches it opens it again from them, and lets the reads that the swap held go on.
    fn set_aside(&self, closed: ClosedIndex) {
        let name = &self.restored.name;
        let _ = self.durable.release_logs(name);
        let lifecycle = &self.engine.lifecycle;
        let reopens = self
            .previous
            .map_or(0, |previous| previous.residency.reopen_count());
        lifecycle.record_closed(name, ClosedEntry::new(closed, reopens));
        self.engine.indexes_mut().remove(name);
        if let Some(previous) = self.previous {
            previous.retire();
        }
        lifecycle.changed.notify_all();
        if let Some(previous) = self.previous {
            previous.residency.end_swap();
        }
    }

    /// Moves the staged files into the index's place and loads the restored index's paged segments from there,
    /// returning the log that the restored index writes to.
    ///
    /// A failure after the open index closed its files records the index as closed on whatever files hold its
    /// name afterwards: the open index's own where the store put them back, or the restored ones where the store
    /// committed the swap and failed, so that no call reads an index whose files are closed.
    pub(super) fn run(
        &self,
        staged: &mut RestoreStaging<'_>,
        metadata: IndexMetadata,
    ) -> Result<IndexLog> {
        let previous_facts = self.previous.map(|previous| {
            let mut facts = closed_facts(previous);
            facts.saved_bytes = previous.log().map(|log| log.saved_size().bytes);
            facts
        });
        let mut restored_facts = closed_facts(self.restored);
        restored_facts.saved_bytes = Some(SavedSize::of(self.manifest).bytes);
        let mut released = false;
        let mut release = || {
            released = true;
            self.release_files();
        };
        let adopted = self
            .durable
            .adopt_restore(staged, self.manifest, metadata, &mut release);
        let log = match adopted {
            Ok(log) => log,
            Err(error) => {
                if released && let Some(facts) = previous_facts {
                    self.set_aside(facts);
                }
                return Err(error);
            }
        };
        if self.reopens_text()
            && let Err(error) = self
                .durable
                .load_restored_segments(self.restored, self.manifest)
        {
            self.set_aside(previous_facts.unwrap_or(restored_facts));
            return Err(error);
        }
        Ok(log)
    }
}
