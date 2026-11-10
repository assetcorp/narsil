use std::collections::{BTreeSet, HashSet};
use std::path::PathBuf;

use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::envelope::{Compression, MAX_FILE_BYTES};
use crate::format::layout::{manifest_key, segments_prefix};
use crate::format::manifest::{
    DecodedManifest, SegmentManifest, decode_manifest_payload, encode_manifest,
    open_manifest_payload,
};
use crate::format::manifest_refs::FileRef;
use crate::format::metadata::{IndexMetadata, write_metadata_file};

use super::checkpoint_store::CheckpointStore;
use super::earlier::decode_earlier_manifest;
use super::envelope_sink::{EnvelopeSink, packed_file_ref};
use super::files::require_valid_key;
use super::sync_files::read_published;

/// The step that a checkpoint commit takes once its manifest is durable and before it removes the files that the
/// manifest no longer lists: the index moves onto the files that the checkpoint wrote and returns the paths of the
/// earlier files that it still reads, which the commit keeps until a later checkpoint.
pub(crate) type ManifestCommitted<'a> = dyn FnMut() -> HashSet<PathBuf> + 'a;

pub(crate) fn snapshot_bundle_key(index_name: &str) -> String {
    format!("{index_name}/snapshot")
}

pub(crate) fn published_snapshot_key(index_name: &str) -> String {
    format!("{index_name}/sync/published")
}

pub(crate) fn metadata_key(index_name: &str) -> String {
    format!("{index_name}/meta")
}

pub(crate) fn read_manifest(
    store: &dyn CheckpointStore,
    index_name: &str,
) -> Result<Option<DecodedManifest>> {
    let Some(bytes) = store.read_within(&manifest_key(index_name), MAX_FILE_BYTES)? else {
        return Ok(None);
    };
    let (_, raw) = open_manifest_payload(&bytes)?;
    decode_manifest_payload(&raw, index_name).map(Some)
}

pub(crate) fn read_current_manifest(
    store: &dyn CheckpointStore,
    index_name: &str,
) -> Result<Option<SegmentManifest>> {
    Ok(match read_manifest(store, index_name)? {
        Some(DecodedManifest::Current(manifest)) => Some(manifest),
        _ => None,
    })
}

fn published_keys(store: &dyn CheckpointStore, index_name: &str) -> Result<BTreeSet<String>> {
    Ok(read_published(store, index_name)?
        .map(|published| published.keys)
        .unwrap_or_default())
}

pub(crate) fn unlisted_segment_keys(
    store: &dyn CheckpointStore,
    index_name: &str,
    listed: &BTreeSet<String>,
    keeps: &dyn Fn(&str) -> bool,
) -> Result<Vec<String>> {
    let published = published_keys(store, index_name)?;
    Ok(store
        .list(&segments_prefix(index_name))?
        .into_iter()
        .filter(|key| !listed.contains(key) && !published.contains(key) && !keeps(key))
        .collect())
}

pub(crate) fn manifest_keys(manifest: &SegmentManifest) -> BTreeSet<String> {
    manifest
        .file_refs()
        .into_iter()
        .map(|file| file.key.clone())
        .collect()
}

pub(crate) struct CheckpointFiles<'s> {
    store: &'s dyn CheckpointStore,
    index_name: String,
    prior: Option<SegmentManifest>,
    reserved: BTreeSet<String>,
    upgrades_earlier: bool,
    directories: BTreeSet<PathBuf>,
    written: BTreeSet<String>,
}

impl<'s> CheckpointFiles<'s> {
    pub(crate) fn open(
        store: &'s dyn CheckpointStore,
        index_name: &str,
    ) -> Result<CheckpointFiles<'s>> {
        let (prior, reserved, upgrades_earlier) = match read_manifest(store, index_name)? {
            Some(DecodedManifest::Current(manifest)) => {
                let reserved = manifest_keys(&manifest);
                (Some(manifest), reserved, false)
            }
            Some(DecodedManifest::Earlier(raw)) => {
                let earlier = decode_earlier_manifest(&raw)?;
                (None, earlier.referenced_keys(), true)
            }
            None => (None, BTreeSet::new(), false),
        };
        Ok(CheckpointFiles {
            store,
            index_name: index_name.to_string(),
            prior,
            reserved,
            upgrades_earlier,
            directories: BTreeSet::new(),
            written: BTreeSet::new(),
        })
    }

    pub(crate) fn index_name(&self) -> &str {
        &self.index_name
    }

    pub(crate) fn prior(&self) -> Option<&SegmentManifest> {
        self.prior.as_ref()
    }

    pub(crate) fn require_new_key(&self, key: &str) -> Result<()> {
        require_valid_key(key)?;
        let prefix = segments_prefix(&self.index_name);
        if key.starts_with(&prefix) && !self.reserved.contains(key) && !self.written.contains(key) {
            return Ok(());
        }
        Err(NarsilError::new(
            ErrorCode::PERSISTENCE_SAVE_FAILED,
            format!(
                "A checkpoint of index \"{}\" cannot write \"{key}\", which is outside \"{prefix}\" or already holds a listed file",
                self.index_name
            ),
        ))
    }

    fn note(&mut self, key: &str, directory: Option<PathBuf>) {
        self.written.insert(key.to_string());
        self.directories.extend(directory);
    }

    pub(crate) fn write_file(&mut self, key: &str, packed: &[u8]) -> Result<FileRef> {
        self.require_new_key(key)?;
        let file = packed_file_ref(key, packed)?;
        let mut sink = self.store.begin_file(key)?;
        sink.write_bytes(packed)?;
        let directory = self.store.finish_file(sink)?;
        self.note(key, directory);
        Ok(file)
    }

    pub(crate) fn create_envelope(&mut self, key: &str, version: u8) -> Result<EnvelopeSink> {
        self.require_new_key(key)?;
        EnvelopeSink::new(key, self.store.begin_file(key)?, version)
    }

    pub(crate) fn finish_envelope(&mut self, sink: EnvelopeSink) -> Result<FileRef> {
        let (sink, file) = sink.seal()?;
        let key = file.key.clone();
        let directory = self.store.finish_file(sink)?;
        self.note(&key, directory);
        Ok(file)
    }

    pub(crate) fn sync_written(&self) -> Result<()> {
        let directories: Vec<PathBuf> = self.directories.iter().cloned().collect();
        self.store.sync_directories(&directories)
    }

    pub(crate) fn require_listed_files_present(&self, manifest: &SegmentManifest) -> Result<()> {
        for file in manifest.file_refs() {
            if self.written.contains(&file.key) {
                continue;
            }
            let carried = match &self.prior {
                Some(prior) => prior.file_refs().into_iter().any(|listed| listed == file),
                None => self.upgrades_earlier && self.reserved.contains(&file.key),
            };
            if !carried {
                return Err(NarsilError::new(
                    ErrorCode::PERSISTENCE_SAVE_FAILED,
                    format!(
                        "The manifest of index \"{}\" lists \"{}\", which this checkpoint neither wrote nor carried from the previous manifest",
                        self.index_name, file.key
                    ),
                ));
            }
        }
        Ok(())
    }

    pub(crate) fn write_manifest(&self, packed: &[u8]) -> Result<()> {
        self.store
            .write_commit(&manifest_key(&self.index_name), packed)
    }

    pub(crate) fn remove_garbage(
        &self,
        manifest: &SegmentManifest,
        keeps: &dyn Fn(&str) -> bool,
    ) -> Result<()> {
        let listed = manifest_keys(manifest);
        for key in unlisted_segment_keys(self.store, &self.index_name, &listed, keeps)? {
            self.store.remove(&key)?;
        }
        self.store.remove(&snapshot_bundle_key(&self.index_name))
    }

    pub(crate) fn write_metadata(&self, packed: &[u8]) -> Result<()> {
        self.store
            .write_commit(&metadata_key(&self.index_name), packed)
    }
}

pub(crate) struct PackedCommit {
    pub(crate) manifest: Vec<u8>,
    pub(crate) metadata: Vec<u8>,
}

pub(crate) fn pack_commit(
    index_name: &str,
    manifest: &SegmentManifest,
    metadata: &IndexMetadata,
) -> Result<PackedCommit> {
    if metadata.index_name != index_name {
        return Err(NarsilError::new(
            ErrorCode::PERSISTENCE_SAVE_FAILED,
            format!(
                "A checkpoint of index \"{index_name}\" received the metadata of index \"{}\"",
                metadata.index_name
            ),
        ));
    }
    Ok(PackedCommit {
        manifest: encode_manifest(manifest, Compression::None)?,
        metadata: write_metadata_file(metadata, Compression::None)?,
    })
}
