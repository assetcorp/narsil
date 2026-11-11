use std::collections::{BTreeMap, HashSet};
use std::io::Write;
use std::sync::Arc;

use super::backing::{Backing, CheckpointTarget};
use super::checkpoint::{CheckpointPlan, build_checkpoint, write_checkpoint_locked};
use super::constants::ARCHIVE_COPY_CHUNK_BYTES;
use super::metadata::{created_metadata, metadata_of};
use crate::analysis::StopWords;
use crate::config::{PayloadFacts, StopWordsSetting, TokenizerSetting, configuration_payload};
use crate::durability::archive_pins::PinnedCheckpoint;
use crate::durability::checkpoint_store::{CheckpointStore, FileLength, read_listed_payload};
use crate::durability::constants::DEFAULT_COMPACTION_THRESHOLD;
use crate::durability::persistence::MemoryPersistence;
use crate::durability::snapshot_only::SnapshotStore;
use crate::engine::index::IndexState;
use crate::engine::sync::sync_epoch_of;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::envelope::{Compression, MAX_FILE_BYTES};
use crate::format::index_configuration::encode_index_configuration;
use crate::format::layout::manifest_key;
use crate::format::manifest::{
    DecodedManifest, SegmentManifest, decode_manifest_payload, open_manifest_payload,
};
use crate::format::manifest_refs::FileRef;
use crate::format::metadata::IndexMetadata;
use crate::value::{Map, Value};

enum ArchiveFiles {
    Stored(Backing, PinnedCheckpoint),
    Memory(SnapshotStore),
}

/// One checkpoint of an index, whose files a snapshot archive or a document export reads: the newest checkpoint
/// of a write-ahead log, pinned until this value drops, or a checkpoint written into memory.
pub(crate) struct ArchiveCheckpoint {
    pub(crate) manifest_bytes: Vec<u8>,
    pub(crate) manifest: SegmentManifest,
    pub(crate) capture_epoch: Option<String>,
    files: ArchiveFiles,
}

fn save_failed(message: String) -> NarsilError {
    NarsilError::new(ErrorCode::PERSISTENCE_SAVE_FAILED, message)
}

fn write_failed(error: std::io::Error) -> NarsilError {
    save_failed(format!(
        "The snapshot archive could not be written: {error}"
    ))
}

impl ArchiveCheckpoint {
    fn store(&self) -> &dyn CheckpointStore {
        match &self.files {
            ArchiveFiles::Stored(backing, _) => backing.files(),
            ArchiveFiles::Memory(store) => store.store(),
        }
    }

    fn read_checked<T>(&self, read: impl FnOnce(&dyn CheckpointStore) -> Result<T>) -> Result<T> {
        let outcome = read(self.store());
        if let ArchiveFiles::Stored(_, pinned) = &self.files {
            pinned.require_unreplaced()?;
        }
        outcome
    }

    /// Writes the bytes of the listed `file` to `out`, in pieces where the store reads ranges of a file.
    pub(crate) fn copy_file(&self, file: &FileRef, out: &mut dyn Write) -> Result<()> {
        let length = self.read_checked(|store| store.length(&file.key))?;
        if !matches!(length, FileLength::Known(_)) {
            let bytes = self
                .read_checked(|store| store.read_within(&file.key, MAX_FILE_BYTES))?
                .ok_or_else(|| {
                    save_failed(format!("The archive file \"{}\" is missing", file.key))
                })?;
            return out.write_all(&bytes).map_err(write_failed);
        }
        let mut offset = 0;
        while offset < file.bytes {
            let length = (file.bytes - offset).min(ARCHIVE_COPY_CHUNK_BYTES);
            let piece = self.read_checked(|store| store.read_range(&file.key, offset, length))?;
            out.write_all(&piece).map_err(write_failed)?;
            offset += length;
        }
        Ok(())
    }

    /// Returns `length` bytes of the listed `file` from `offset`.
    pub(crate) fn read_range(&self, file: &FileRef, offset: u64, length: u64) -> Result<Vec<u8>> {
        self.read_checked(|store| store.read_range(&file.key, offset, length))
    }

    /// Returns the payload of a listed file, checked against its envelope and the manifest.
    pub(crate) fn read_listed(
        &self,
        file: &FileRef,
        what: &str,
        version: u8,
        allows_compression: bool,
    ) -> Result<Vec<u8>> {
        self.read_checked(|store| {
            read_listed_payload(store, file, what, version, allows_compression)
        })
    }
}

/// Returns the metadata that `index` records now: the durable record where it has one, else the record of a new
/// index with the same settings.
pub(crate) fn current_metadata(index: &IndexState) -> IndexMetadata {
    match index.log() {
        Some(log) => log.metadata(index),
        None => metadata_of(
            index,
            &created_metadata(&index.name, index.analyser().language()),
        ),
    }
}

/// Returns the index configuration that a snapshot archive and a document export carry, refusing an index whose
/// tokenizer or stop words are code, which no file can hold.
pub(crate) fn index_configuration(index: &IndexState, metadata: &IndexMetadata) -> Result<Map> {
    let config = index.config();
    if matches!(config.tokenizer, Some(TokenizerSetting::Instance(_))) {
        return Err(NarsilError::new(
            ErrorCode::CONFIG_INVALID,
            "A snapshot persists no code, so the index tokenizer must be a name registered with registerTokenizer",
        ));
    }
    if matches!(
        config.stop_words,
        Some(StopWordsSetting::Words(StopWords::Function(_)))
    ) {
        return Err(NarsilError::new(
            ErrorCode::CONFIG_INVALID,
            "A snapshot persists no code, so the index stop words must be a name registered with registerStopWords",
        ));
    }
    let synonyms = index.synonym_set().rules.clone();
    let adapter_name = index
        .vectors
        .embedding()
        .and_then(|binding| binding.adapter_name());
    let facts = PayloadFacts {
        language: &metadata.language,
        adapter_name,
        analysis_revision: metadata.analysis_revision.as_deref(),
        array_position_gap: metadata
            .array_position_gap
            .and_then(|gap| (gap >= 0.0 && gap <= f64::from(u32::MAX)).then_some(gap as u32)),
        synonyms: (!synonyms.is_empty()).then_some(synonyms.as_slice()),
        analysis_generation: metadata.analysis_generation.unwrap_or(0),
    };
    let mut payload = configuration_payload(&config, &facts);
    index.suggestion_state().write_payload(&mut payload);
    if let Some(epoch) = sync_epoch_of(metadata) {
        payload.insert("syncEpoch", Value::String(epoch.to_string()));
    }
    Ok(payload)
}

/// Returns the bytes of the index configuration file of a snapshot archive.
pub(crate) fn encoded_configuration(
    index: &IndexState,
    metadata: &IndexMetadata,
) -> Result<Vec<u8>> {
    encode_index_configuration(&index_configuration(index, metadata)?, Compression::None)
}

fn memory_checkpoint(index: &IndexState) -> Result<ArchiveCheckpoint> {
    let store = SnapshotStore::open(Arc::new(MemoryPersistence::new()))?;
    let _writer = index.lock_writes()?;
    let applied: BTreeMap<u32, u64> = index
        .log()
        .map(|log| log.applied_seq_nos())
        .unwrap_or_default();
    let partitions = index.partitions();
    let mut target = CheckpointTarget::Snapshot(store.begin_checkpoint(&index.name)?);
    let plan = CheckpointPlan {
        applied: &applied,
        metadata: current_metadata(index),
        compaction_threshold: DEFAULT_COMPACTION_THRESHOLD,
        upgraded: None,
    };
    let built = build_checkpoint(&mut target, index, &partitions, plan)?;
    target.commit(&built.manifest, &built.metadata, &mut HashSet::new)?;
    let manifest_bytes = store
        .store()
        .read_within(&manifest_key(&index.name), MAX_FILE_BYTES)?
        .ok_or_else(|| {
            save_failed(format!(
                "The archive of index \"{}\" holds no manifest",
                index.name
            ))
        })?;
    let (_, raw) = open_manifest_payload(&manifest_bytes)?;
    let DecodedManifest::Current(manifest) = decode_manifest_payload(&raw, &index.name)? else {
        return Err(save_failed(format!(
            "The archive of index \"{}\" holds no manifest",
            index.name
        )));
    };
    Ok(ArchiveCheckpoint {
        manifest_bytes,
        manifest,
        capture_epoch: None,
        files: ArchiveFiles::Memory(store),
    })
}

/// Returns a checkpoint of `index` for an archive: under the write-ahead log, a new checkpoint whose files stay
/// pinned, so that the archive holds every write acknowledged before the call; otherwise a checkpoint that the
/// engine writes into memory from the index as it stands. Each holds the index's write lock until its files are
/// pinned or copied, so that a restore cannot replace the files under the index's name in between, and so that the
/// change capture epoch that it reads belongs to the same moment as the checkpoint's positions.
pub(crate) fn archive_checkpoint(index: &IndexState) -> Result<ArchiveCheckpoint> {
    if let Some(log) = index.log()
        && let Backing::Log(_) = log.backing()
    {
        let _writer = index.lock_writes()?;
        write_checkpoint_locked(index, log, None)?;
        let pinned = log.backing().pin_checkpoint(&index.name)?;
        return Ok(ArchiveCheckpoint {
            manifest_bytes: pinned.manifest_bytes.clone(),
            manifest: pinned.manifest.clone(),
            capture_epoch: log.recorded_capture().0,
            files: ArchiveFiles::Stored(log.backing().clone(), pinned),
        });
    }
    memory_checkpoint(index)
}
