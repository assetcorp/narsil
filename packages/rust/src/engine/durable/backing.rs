use std::path::PathBuf;
use std::sync::Arc;

use crate::durability::archive_pins::PinnedCheckpoint;
use crate::durability::checkpoint::CheckpointWriter;
use crate::durability::checkpoint_files::ManifestCommitted;
use crate::durability::checkpoint_store::CheckpointStore;
use crate::durability::envelope_sink::EnvelopeSink;
use crate::durability::recovery::RecoveredIndex;
use crate::durability::snapshot_only::{SnapshotCheckpoint, SnapshotStore};
use crate::durability::store::DurabilityStore;
use crate::error::{NarsilError, Result};
use crate::format::manifest::SegmentManifest;
use crate::format::manifest_refs::FileRef;
use crate::format::metadata::IndexMetadata;

/// Where a durable engine keeps its files: a directory with a write-ahead log, or a persistence adapter that
/// takes whole checkpoints.
#[derive(Clone)]
pub(crate) enum Backing {
    Log(Arc<DurabilityStore>),
    Snapshot(Arc<SnapshotStore>),
}

/// A checkpoint that writes its files, then commits a manifest that lists them.
pub(crate) enum CheckpointTarget<'a> {
    Log(CheckpointWriter<'a>),
    Snapshot(SnapshotCheckpoint<'a>),
}

impl Backing {
    pub(crate) fn files(&self) -> &dyn CheckpointStore {
        match self {
            Backing::Log(store) => &store.inner.directory,
            Backing::Snapshot(store) => store.store(),
        }
    }

    /// Returns the path of a stored file where the engine keeps its files in a directory.
    pub(crate) fn path_of(&self, key: &str) -> Result<Option<PathBuf>> {
        match self {
            Backing::Log(store) => store.inner.directory.path_of(key).map(Some),
            Backing::Snapshot(_) => Ok(None),
        }
    }

    pub(crate) fn fatal_error(&self) -> Option<NarsilError> {
        match self {
            Backing::Log(store) => store.fatal_error(),
            Backing::Snapshot(_) => None,
        }
    }

    pub(crate) fn index_names(&self) -> Result<Vec<String>> {
        match self {
            Backing::Log(store) => store.index_names(),
            Backing::Snapshot(store) => store.index_names(),
        }
    }

    pub(crate) fn open_index(&self, index_name: &str) -> Result<Option<RecoveredIndex>> {
        match self {
            Backing::Log(store) => store.open_index(index_name),
            Backing::Snapshot(store) => store.open_index(index_name),
        }
    }

    pub(crate) fn read_listed(
        &self,
        file: &FileRef,
        what: &str,
        version: u8,
        allows_compression: bool,
    ) -> Result<Vec<u8>> {
        match self {
            Backing::Log(store) => store.read_listed(file, what, version, allows_compression),
            Backing::Snapshot(store) => store.read_listed(file, what, version, allows_compression),
        }
    }

    pub(crate) fn write_metadata(&self, metadata: &IndexMetadata) -> Result<()> {
        match self {
            Backing::Log(store) => store.write_metadata(metadata),
            Backing::Snapshot(store) => store.write_metadata(metadata),
        }
    }

    pub(crate) fn remove_index(&self, index_name: &str) -> Result<()> {
        match self {
            Backing::Log(store) => store.remove_index(index_name),
            Backing::Snapshot(store) => store.remove_index(index_name),
        }
    }

    /// Pins the files of the newest checkpoint of `index_name`, which stay on the store until the pins drop.
    pub(crate) fn pin_checkpoint(&self, index_name: &str) -> Result<PinnedCheckpoint> {
        match self {
            Backing::Log(store) => store.pin_checkpoint(index_name),
            Backing::Snapshot(store) => store.pin_checkpoint(index_name),
        }
    }

    pub(crate) fn begin_checkpoint(&self, index_name: &str) -> Result<CheckpointTarget<'_>> {
        match self {
            Backing::Log(store) => store
                .begin_checkpoint(index_name)
                .map(CheckpointTarget::Log),
            Backing::Snapshot(store) => store
                .begin_checkpoint(index_name)
                .map(CheckpointTarget::Snapshot),
        }
    }
}

impl CheckpointTarget<'_> {
    pub(crate) fn prior(&self) -> Option<&SegmentManifest> {
        match self {
            CheckpointTarget::Log(writer) => writer.prior(),
            CheckpointTarget::Snapshot(writer) => writer.prior(),
        }
    }

    /// Returns the highest sequence number that the log of each partition holds, which the snapshot tier keeps
    /// in memory instead.
    pub(crate) fn highest_logged(&self) -> Result<Option<Vec<(u32, u64)>>> {
        let CheckpointTarget::Log(writer) = self else {
            return Ok(None);
        };
        let mut highest = Vec::new();
        for log in writer.logs()? {
            highest.push((log.partition_id(), log.highest_appended()?));
        }
        Ok(Some(highest))
    }

    pub(crate) fn write_file(&mut self, key: &str, packed: &[u8]) -> Result<FileRef> {
        match self {
            CheckpointTarget::Log(writer) => writer.write_file(key, packed),
            CheckpointTarget::Snapshot(writer) => writer.write_file(key, packed),
        }
    }

    pub(crate) fn create_envelope(&mut self, key: &str, version: u8) -> Result<EnvelopeSink> {
        match self {
            CheckpointTarget::Log(writer) => writer.create_envelope(key, version),
            CheckpointTarget::Snapshot(writer) => writer.create_envelope(key, version),
        }
    }

    pub(crate) fn finish_envelope(&mut self, sink: EnvelopeSink) -> Result<FileRef> {
        match self {
            CheckpointTarget::Log(writer) => writer.finish_envelope(sink),
            CheckpointTarget::Snapshot(writer) => writer.finish_envelope(sink),
        }
    }

    /// Returns the path that `key` takes where the checkpoint writes its files into a directory, creating the
    /// directory that holds it, or `None` where a persistence adapter takes them.
    pub(crate) fn path_of(&self, key: &str) -> Result<Option<PathBuf>> {
        match self {
            CheckpointTarget::Log(writer) => writer.path_of(key).map(Some),
            CheckpointTarget::Snapshot(_) => Ok(None),
        }
    }

    pub(crate) fn commit(
        self,
        manifest: &SegmentManifest,
        metadata: &IndexMetadata,
        committed: &mut ManifestCommitted<'_>,
    ) -> Result<()> {
        match self {
            CheckpointTarget::Log(writer) => writer.commit(manifest, metadata, committed),
            CheckpointTarget::Snapshot(writer) => writer.commit(manifest, metadata, committed),
        }
    }
}
