use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Instant;

use crate::error::Result;
use crate::format::manifest::{PartitionCheckpoint, SegmentManifest};
use crate::format::manifest_refs::FileRef;
use crate::format::metadata::IndexMetadata;

use super::checkpoint_files::{CheckpointFiles, ManifestCommitted, pack_commit};
use super::envelope_sink::{EnvelopeSink, packed_file_ref};
use super::index_state::{IndexState, index_poisoned};
use super::log_reader::{list_segments, read_marker};
use super::log_writer::PartitionLog;
use super::platform::now_ms;
use super::store::DurabilityStore;
use super::store_inner::StoreInner;
use super::sync_files::history_key;

pub(crate) struct CheckpointWriter<'a> {
    inner: &'a StoreInner,
    state: Arc<IndexState>,
    files: CheckpointFiles<'a>,
}

impl Drop for CheckpointWriter<'_> {
    fn drop(&mut self) {
        self.state.checkpoint_turn.give_back();
    }
}

fn truncate_covered_segments(
    inner: &StoreInner,
    index_name: &str,
    checkpoint: &[PartitionCheckpoint],
    moved_into_history_at_ms: Option<u64>,
) -> Result<bool> {
    let mut moved = false;
    for target in checkpoint {
        let Some(marker) = read_marker(&inner.directory, index_name, target.partition_id)? else {
            continue;
        };
        let segments = list_segments(&inner.directory, index_name, target.partition_id)?;
        for (position, segment) in segments.iter().enumerate() {
            if segment.start_seq_no >= marker.active_segment_seq_no {
                break;
            }
            let covered = segments
                .get(position + 1)
                .is_some_and(|next| next.start_seq_no <= target.last_seq_no.saturating_add(1));
            if !covered {
                break;
            }
            match moved_into_history_at_ms {
                Some(moved_at_ms) => {
                    let target = history_key(
                        index_name,
                        target.partition_id,
                        segment.start_seq_no,
                        moved_at_ms,
                    );
                    moved |= inner.directory.rename(&segment.key, &target)?;
                }
                None => inner.directory.remove(&segment.key)?,
            }
        }
    }
    Ok(moved)
}

fn wal_partition_of<'k>(key: &'k str, root: &str) -> Option<&'k str> {
    let (partition, _) = key.strip_prefix(root)?.split_once('/')?;
    let numeric = !partition.is_empty() && partition.bytes().all(|byte| byte.is_ascii_digit());
    numeric.then_some(partition)
}

fn reclaim_logs_beyond(inner: &StoreInner, index_name: &str, partition_count: u32) -> Result<()> {
    inner.forget_partitions_from(index_name, partition_count)?;
    let root = format!("{index_name}/wal/");
    for key in inner.directory.list(&root)? {
        let beyond = wal_partition_of(&key, &root).is_some_and(|partition| {
            partition
                .parse::<u64>()
                .map_or(true, |id| id >= partition_count as u64)
        });
        if beyond {
            inner.directory.remove(&key)?;
        }
    }
    Ok(())
}

fn records_beyond(checkpoint: &[PartitionCheckpoint], logs: &[Arc<PartitionLog>]) -> u64 {
    let covered: HashMap<u32, u64> = checkpoint
        .iter()
        .map(|target| (target.partition_id, target.last_seq_no))
        .collect();
    logs.iter()
        .map(|log| {
            let appended = log.highest_appended().unwrap_or(0);
            appended.saturating_sub(covered.get(&log.partition_id()).copied().unwrap_or(0))
        })
        .sum()
}

impl CheckpointWriter<'_> {
    pub(crate) fn prior(&self) -> Option<&SegmentManifest> {
        self.files.prior()
    }

    /// Returns the log of each partition of the index that the checkpoint covers.
    pub(crate) fn logs(&self) -> Result<Vec<Arc<PartitionLog>>> {
        self.inner.logs_of(self.files.index_name())
    }

    pub(crate) fn write_file(&mut self, key: &str, packed: &[u8]) -> Result<FileRef> {
        self.files.require_new_key(key)?;
        packed_file_ref(key, packed)?;
        let outcome = self.files.write_file(key, packed);
        self.inner.guard(outcome)
    }

    pub(crate) fn create_envelope(&mut self, key: &str, version: u8) -> Result<EnvelopeSink> {
        self.files.require_new_key(key)?;
        let outcome = self.files.create_envelope(key, version);
        self.inner.guard(outcome)
    }

    pub(crate) fn finish_envelope(&mut self, sink: EnvelopeSink) -> Result<FileRef> {
        let outcome = self.files.finish_envelope(sink);
        self.inner.guard(outcome)
    }

    /// Returns the path that `key` takes in the store's directory, creating the directory that holds it.
    pub(crate) fn path_of(&self, key: &str) -> Result<std::path::PathBuf> {
        self.inner
            .directory
            .ensure_parent(key)
            .map(|(path, _)| path)
    }

    pub(crate) fn commit(
        self,
        manifest: &SegmentManifest,
        metadata: &IndexMetadata,
        committed: &mut ManifestCommitted<'_>,
    ) -> Result<()> {
        let index_name = self.files.index_name().to_string();
        let packed = pack_commit(&index_name, manifest, metadata)?;
        self.files.require_listed_files_present(manifest)?;
        let logs = self.inner.logs_of(&index_name)?;
        self.inner.flush_logs(&logs)?;
        self.inner.guard(self.files.sync_written())?;
        self.inner.verify()?;
        self.inner
            .guard(self.files.write_manifest(&packed.manifest))?;
        let still_read = committed();
        let pins = self.state.pinned()?;
        let directory = &self.inner.directory;
        let keeps = |key: &str| {
            pins.contains_key(key)
                || (!still_read.is_empty()
                    && directory
                        .path_of(key)
                        .is_ok_and(|path| still_read.contains(&path)))
        };
        self.inner
            .guard(self.files.remove_garbage(manifest, &keeps))?;
        {
            let _turn = self
                .state
                .metadata_turn
                .lock()
                .map_err(|_| index_poisoned())?;
            self.inner
                .guard(self.files.write_metadata(&packed.metadata))?;
        }
        let moved_at_ms = metadata.keeps_history().then(now_ms);
        let outcome =
            truncate_covered_segments(self.inner, &index_name, &manifest.checkpoint, moved_at_ms)
                .and_then(|moved| {
                    reclaim_logs_beyond(self.inner, &index_name, metadata.partition_count)?;
                    Ok(moved)
                });
        if self.inner.guard(outcome)? {
            self.state.note_history_moved();
        }
        self.state.mutations.store(
            records_beyond(&manifest.checkpoint, &logs),
            Ordering::Relaxed,
        );
        if let Ok(mut last) = self.state.last_checkpoint.lock() {
            *last = Instant::now();
        }
        Ok(())
    }
}

impl DurabilityStore {
    pub(crate) fn begin_checkpoint(&self, index_name: &str) -> Result<CheckpointWriter<'_>> {
        let inner: &StoreInner = &self.inner;
        inner.verify()?;
        let state = inner.index_state(index_name)?;
        state.checkpoint_turn.take()?;
        let writer = match CheckpointFiles::open(&inner.directory, index_name) {
            Ok(files) => CheckpointWriter {
                inner,
                state: state.clone(),
                files,
            },
            Err(error) => {
                state.checkpoint_turn.give_back();
                return Err(error);
            }
        };
        for log in inner.logs_of(index_name)? {
            inner.guard(log.roll_for_checkpoint(&inner.directory))?;
        }
        Ok(writer)
    }
}
