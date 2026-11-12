use std::collections::BTreeSet;

use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::envelope::MAX_FILE_BYTES;
use crate::format::manifest::{DecodedManifest, PartitionCheckpoint, SegmentManifest};
use crate::format::manifest_refs::FileRef;
use crate::format::metadata::{IndexMetadata, open_lenient_envelope, read_metadata_file};
use crate::format::wal::LogEntry;

use super::checkpoint_files::{
    manifest_keys, metadata_key, read_manifest, snapshot_bundle_key, unlisted_segment_keys,
};
use super::checkpoint_store::{CheckpointStore, read_listed_payload};
use super::constants::SINGLE_NODE_PRIMARY_TERM;
use super::earlier::{EarlierManifest, decode_earlier_manifest};
use super::files::TEMPORARY_MARK;
use super::log_reader::{LogVisit, replay_partition_log};
use super::log_segment::LogStart;
use super::restore_journal::{is_valid_index_name, require_index_name, top_level_names};
use super::store::DurabilityStore;
use super::sync_files::settle_sync_files;

const EARLIER_FILE_MAX_ENVELOPE_VERSION: u8 = 2;
const LEFTOVER_REWRITE_PLACES: [&str; 2] = ["rebuilt", "received"];

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum StoredCheckpoint {
    Empty,
    Current(SegmentManifest),
    Earlier(EarlierManifest),
    Bundle(Vec<u8>),
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RecoveredIndex {
    pub(crate) metadata: IndexMetadata,
    pub(crate) metadata_changed: bool,
    pub(crate) checkpoint: StoredCheckpoint,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ReplayedPartition {
    pub(crate) last_seq_no: u64,
    pub(crate) primary_term: u64,
}

fn settle_stored_analysis(metadata: &mut IndexMetadata, stored: Option<u64>) -> Result<bool> {
    let current = metadata.analysis_generation.unwrap_or(0);
    let Some(stored) = stored.filter(|stored| *stored != current) else {
        return Ok(false);
    };
    match metadata.pending_analysis.take() {
        Some(pending) if pending.generation == stored => {
            metadata.language = pending.language;
            metadata.analysis_generation = Some(pending.generation);
            metadata.analysis_revision = None;
            metadata.analysis = pending.analysis;
            Ok(true)
        }
        pending => {
            metadata.pending_analysis = pending;
            Err(NarsilError::new(
                ErrorCode::CONFIG_INVALID,
                format!(
                    "The saved terms of index \"{}\" come from analysis generation {stored}, which matches no settings that its metadata records",
                    metadata.index_name
                ),
            ))
        }
    }
}

fn remove_unlisted(
    store: &dyn CheckpointStore,
    index_name: &str,
    listed: &BTreeSet<String>,
    keeps: &dyn Fn(&str) -> bool,
) -> Result<()> {
    for key in unlisted_segment_keys(store, index_name, listed, keeps)? {
        store.remove(&key)?;
    }
    Ok(())
}

pub(crate) fn index_names_in(keys: Vec<String>) -> Vec<String> {
    let mut names: Vec<String> = keys
        .into_iter()
        .filter_map(|key| key.strip_suffix("/meta").map(str::to_string))
        .filter(|name| is_valid_index_name(name))
        .collect();
    names.sort();
    names.dedup();
    names
}

pub(crate) fn open_stored_index(
    store: &dyn CheckpointStore,
    index_name: &str,
    keeps: &dyn Fn(&str) -> bool,
) -> Result<Option<RecoveredIndex>> {
    let Some(bytes) = store.read_within(&metadata_key(index_name), MAX_FILE_BYTES)? else {
        return Ok(None);
    };
    let (_, mut metadata) = read_metadata_file(&bytes)?;
    settle_sync_files(store, index_name, &metadata)?;
    let (checkpoint, stored_generation) = match read_manifest(store, index_name)? {
        Some(DecodedManifest::Earlier(raw)) => (
            StoredCheckpoint::Earlier(decode_earlier_manifest(&raw)?),
            Some(0),
        ),
        Some(DecodedManifest::Current(manifest)) => {
            store.remove(&snapshot_bundle_key(index_name))?;
            remove_unlisted(store, index_name, &manifest_keys(&manifest), keeps)?;
            let generation = manifest.analysis_generation.unwrap_or(0);
            (StoredCheckpoint::Current(manifest), Some(generation))
        }
        None => match store.read_within(&snapshot_bundle_key(index_name), MAX_FILE_BYTES)? {
            Some(bundle) => {
                let (_, payload) =
                    open_lenient_envelope(&bundle, EARLIER_FILE_MAX_ENVELOPE_VERSION)?;
                (StoredCheckpoint::Bundle(payload), None)
            }
            None => {
                remove_unlisted(store, index_name, &BTreeSet::new(), keeps)?;
                (StoredCheckpoint::Empty, None)
            }
        },
    };
    let metadata_changed = settle_stored_analysis(&mut metadata, stored_generation)?;
    Ok(Some(RecoveredIndex {
        metadata,
        metadata_changed,
        checkpoint,
    }))
}

fn checkpoint_of(
    checkpoint: &[PartitionCheckpoint],
    partition_id: u32,
) -> Option<&PartitionCheckpoint> {
    checkpoint
        .iter()
        .find(|entry| entry.partition_id == partition_id)
}

impl DurabilityStore {
    pub(crate) fn index_names(&self) -> Result<Vec<String>> {
        let mut keys = Vec::new();
        for (name, is_directory) in top_level_names(&self.inner.directory)? {
            let candidate = is_directory && is_valid_index_name(&name);
            if candidate
                && self
                    .inner
                    .directory
                    .byte_length(&metadata_key(&name))?
                    .is_some()
            {
                keys.push(metadata_key(&name));
            }
        }
        Ok(index_names_in(keys))
    }

    pub(crate) fn open_index(&self, index_name: &str) -> Result<Option<RecoveredIndex>> {
        self.inner.require_healthy()?;
        require_index_name(index_name)?;
        let directory = &self.inner.directory;
        for place in LEFTOVER_REWRITE_PLACES {
            directory.remove_tree(&format!("{index_name}/{place}"))?;
        }
        for key in directory.list(&format!("{index_name}/"))? {
            let direct_child = key.matches('/').count() == 1;
            if direct_child && key.contains(TEMPORARY_MARK) {
                directory.remove(&key)?;
            }
        }
        let state = self.inner.index_state(index_name)?;
        let pins = state.pinned()?;
        let keeps = |key: &str| pins.contains_key(key);
        open_stored_index(directory, index_name, &keeps)
    }

    pub(crate) fn read_listed(
        &self,
        file: &FileRef,
        what: &str,
        version: u8,
        allows_compression: bool,
    ) -> Result<Vec<u8>> {
        read_listed_payload(
            &self.inner.directory,
            file,
            what,
            version,
            allows_compression,
        )
    }

    pub(crate) fn replay_partition(
        &self,
        index_name: &str,
        partition_id: u32,
        checkpoint: &[PartitionCheckpoint],
        visit: &mut dyn FnMut(LogEntry) -> Result<()>,
    ) -> Result<ReplayedPartition> {
        self.inner.require_healthy()?;
        require_index_name(index_name)?;
        let covered = checkpoint_of(checkpoint, partition_id);
        let after_seq_no = covered.map_or(0, |entry| entry.last_seq_no);
        let replayed = self.inner.guard(replay_partition_log(
            &self.inner.directory,
            index_name,
            partition_id,
            LogVisit {
                after_seq_no,
                up_to_seq_no: u64::MAX,
                visit,
            },
            true,
        ))?;
        let primary_term = covered
            .map_or(0, |entry| entry.primary_term)
            .max(replayed.highest_primary_term)
            .max(SINGLE_NODE_PRIMARY_TERM);
        self.inner.register_log(
            index_name,
            partition_id,
            LogStart {
                active: replayed.active,
                highest_seq_no: replayed.highest_seq_no,
                highest_durable_seq_no: replayed.highest_seq_no,
                primary_term,
            },
        )?;
        Ok(ReplayedPartition {
            last_seq_no: replayed.highest_seq_no,
            primary_term,
        })
    }
}
