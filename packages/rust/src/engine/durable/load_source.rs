use std::path::PathBuf;

use super::backing::Backing;
use crate::durability::checkpoint_store::{CheckpointStore, read_listed_payload};
use crate::durability::restore::RestoreStaging;
use crate::error::Result;
use crate::format::envelope::ENVELOPE_VERSION_BYTE;
use crate::format::manifest_refs::FileRef;

/// Where a checkpoint's files come from while an index loads them: the engine's own store, or a store that holds
/// a restore's files before they belong to the index.
pub(crate) trait CheckpointSource {
    /// Returns the payload of a listed file, checked against its envelope and the manifest.
    fn read_listed(
        &self,
        file: &FileRef,
        what: &str,
        version: u8,
        allows_compression: bool,
    ) -> Result<Vec<u8>>;

    /// Returns the path that a stored file keeps, where the index can map its vectors from it.
    fn path_of(&self, key: &str) -> Result<Option<PathBuf>>;

    /// Returns the path of a stored paged segment, which the index opens and keeps open while it serves, or `None`
    /// where the store keeps no directory that an index can read a file from by position.
    fn paged_path_of(&self, key: &str) -> Result<Option<PathBuf>> {
        self.path_of(key)
    }

    /// Returns the envelope format version that a stored file's header gives, or `None` where the store keeps no
    /// directory that an index can read a paged segment from by position.
    fn envelope_version(&self, key: &str) -> Result<Option<u8>>;

    fn source_for_a_later_read(&self) -> Option<Box<dyn CheckpointSource + Send>>;
}

impl CheckpointSource for Backing {
    fn read_listed(
        &self,
        file: &FileRef,
        what: &str,
        version: u8,
        allows_compression: bool,
    ) -> Result<Vec<u8>> {
        Backing::read_listed(self, file, what, version, allows_compression)
    }

    fn path_of(&self, key: &str) -> Result<Option<PathBuf>> {
        Backing::path_of(self, key)
    }

    fn envelope_version(&self, key: &str) -> Result<Option<u8>> {
        if Backing::path_of(self, key)?.is_none() {
            return Ok(None);
        }
        let byte = self.files().read_range(key, ENVELOPE_VERSION_BYTE, 1)?;
        Ok(byte.first().copied())
    }

    fn source_for_a_later_read(&self) -> Option<Box<dyn CheckpointSource + Send>> {
        Some(Box::new(self.clone()))
    }
}

/// The files that a restore staged before they belong to the index. The index reads its vectors into memory,
/// because the commit moves the files before the index serves, so no path of theirs stays valid. A paged segment
/// stays open on its staged file, whose handle keeps reading the same file after the commit moves the staging
/// directory into the index's place.
pub(crate) enum StagedSource<'a> {
    /// Files staged in a directory of the engine's store.
    Directory(&'a RestoreStaging<'a>),
    /// Files staged in memory, for an engine that keeps no files.
    Memory(&'a dyn CheckpointStore),
}

impl StagedSource<'_> {
    /// Returns the store that holds the staged files under the keys that they take once they belong to the index.
    pub(crate) fn store(&self) -> &dyn CheckpointStore {
        match self {
            StagedSource::Directory(staging) => *staging,
            StagedSource::Memory(store) => *store,
        }
    }
}

impl CheckpointSource for StagedSource<'_> {
    fn read_listed(
        &self,
        file: &FileRef,
        what: &str,
        version: u8,
        allows_compression: bool,
    ) -> Result<Vec<u8>> {
        read_listed_payload(self.store(), file, what, version, allows_compression)
    }

    fn path_of(&self, _key: &str) -> Result<Option<PathBuf>> {
        Ok(None)
    }

    fn paged_path_of(&self, key: &str) -> Result<Option<PathBuf>> {
        match self {
            StagedSource::Directory(staging) => staging.staged_path(key),
            StagedSource::Memory(_) => Ok(None),
        }
    }

    fn envelope_version(&self, key: &str) -> Result<Option<u8>> {
        if self.paged_path_of(key)?.is_none() {
            return Ok(None);
        }
        let byte = self.store().read_range(key, ENVELOPE_VERSION_BYTE, 1)?;
        Ok(byte.first().copied())
    }

    fn source_for_a_later_read(&self) -> Option<Box<dyn CheckpointSource + Send>> {
        None
    }
}
