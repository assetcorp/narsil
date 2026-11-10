use std::path::PathBuf;

use super::backing::Backing;
use crate::durability::checkpoint_store::{CheckpointStore, read_listed_payload};
use crate::error::Result;
use crate::format::envelope::{ENVELOPE_VERSION_BYTE, HEADER_BYTES, read_header};
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

    /// Returns the envelope format version that a stored file's header gives, or `None` where the store keeps no
    /// directory that an index can read a file from by position.
    fn envelope_version(&self, key: &str) -> Result<Option<u8>>;

    /// Reports whether a stored file holds its payload uncompressed in a directory that an index can read it from
    /// by position.
    fn holds_raw_payload(&self, key: &str) -> Result<bool>;
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

    fn holds_raw_payload(&self, key: &str) -> Result<bool> {
        if Backing::path_of(self, key)?.is_none() {
            return Ok(false);
        }
        let header = self.files().read_range(key, 0, HEADER_BYTES as u64)?;
        Ok(!read_header(&header)?.compressed)
    }
}

/// A store whose files an index reads into memory, because they move before the index serves, so no path of
/// theirs stays valid.
pub(crate) struct StagedSource<'a>(pub(crate) &'a dyn CheckpointStore);

impl CheckpointSource for StagedSource<'_> {
    fn read_listed(
        &self,
        file: &FileRef,
        what: &str,
        version: u8,
        allows_compression: bool,
    ) -> Result<Vec<u8>> {
        read_listed_payload(self.0, file, what, version, allows_compression)
    }

    fn path_of(&self, _key: &str) -> Result<Option<PathBuf>> {
        Ok(None)
    }

    fn envelope_version(&self, _key: &str) -> Result<Option<u8>> {
        Ok(None)
    }

    fn holds_raw_payload(&self, _key: &str) -> Result<bool> {
        Ok(false)
    }
}
