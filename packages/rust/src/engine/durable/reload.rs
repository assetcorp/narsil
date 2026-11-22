use std::collections::{HashMap, HashSet};

use super::build::recovered_index;
use super::load::{grow_partitions, is_dead, load_partition};
use super::load_source::CheckpointSource;
use super::recover::apply_entry;
use crate::durability::archive_pins::PinnedCheckpoint;
use crate::durability::checkpoint_files::read_manifest;
use crate::durability::log_reader::LogReplayed;
use crate::durability::replicated_log::ReplicatedLog;
use crate::engine::EngineInner;
use crate::engine::index::IndexState;
use crate::engine::replication::copy_state::{PartitionCopy, ReplicatedCopy};
use crate::engine::vectors::paths::set_value_at;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::manifest::{DecodedManifest, PartitionCheckpoint, SegmentManifest};
use crate::format::vector_file::{VECTOR_FILE_ENVELOPE_VERSION, decode_vector_file};
use crate::format::wal::LogEntry;
use crate::value::{Map, Value};

/// One partition as its checkpoint and its write-ahead log hold it.
pub(crate) struct StoredPartition {
    pub(crate) documents: Vec<(String, Map)>,
    pub(crate) copy: PartitionCopy,
    pub(crate) replayed: Option<LogReplayed>,
}

pub(crate) struct CheckpointedPartition {
    stored: IndexState,
    copy: ReplicatedCopy,
    documents: Vec<(String, Map)>,
    covered: Option<PartitionCheckpoint>,
    _pinned: Option<PinnedCheckpoint>,
}

fn unreadable(index: &IndexState, partition: u32, why: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_LOAD_FAILED,
        format!(
            "Partition {partition} of index \"{}\" cannot be read again, because {why}",
            index.name
        ),
    )
    .with_details([
        ("indexName", Value::from(index.name.as_str())),
        ("partitionId", Value::from(partition)),
    ])
}

fn covered_by(checkpoint: &[PartitionCheckpoint], partition: u32) -> Option<PartitionCheckpoint> {
    checkpoint
        .iter()
        .find(|entry| entry.partition_id == partition)
        .cloned()
}

fn vector_values(values: &[f32]) -> Value {
    Value::Array(
        values
            .iter()
            .map(|value| Value::Number(f64::from(*value)))
            .collect(),
    )
}

fn attach_checkpoint_vectors(
    store: &dyn CheckpointSource,
    index: &IndexState,
    manifest: &SegmentManifest,
    documents: &mut [(String, Map)],
) -> Result<()> {
    let wanted: HashMap<String, usize> = documents
        .iter()
        .enumerate()
        .map(|(at, (id, _))| (id.clone(), at))
        .collect();
    for listed in &manifest.vectors {
        if index.vectors.field(&listed.field_path).is_none() {
            continue;
        }
        let mut found: HashMap<usize, Vec<f32>> = HashMap::new();
        for file in &listed.files {
            let payload = store.read_listed(
                &file.file,
                "vector file",
                VECTOR_FILE_ENVELOPE_VERSION,
                false,
            )?;
            let decoded = decode_vector_file(&payload)?;
            if decoded.field_name != listed.field_path {
                return Err(NarsilError::new(
                    ErrorCode::PERSISTENCE_LOAD_FAILED,
                    format!(
                        "The vector file \"{}\" names field \"{}\" where the manifest lists \"{}\"",
                        file.file.key, decoded.field_name, listed.field_path
                    ),
                )
                .with_details([("key", Value::from(file.file.key.as_str()))]));
            }
            let dimension = decoded.dimension;
            for (position, id) in decoded.doc_ids.iter().enumerate() {
                if is_dead(file.dead.as_deref(), position) {
                    continue;
                }
                let Some(&at) = wanted.get(id) else {
                    continue;
                };
                let start = position * dimension;
                if let Some(values) = decoded.vectors.get(start..start + dimension) {
                    found.insert(at, values.to_vec());
                }
            }
        }
        for (at, values) in found {
            if let Some((_, document)) = documents.get_mut(at) {
                set_value_at(document, &listed.field_path, vector_values(&values));
            }
        }
    }
    Ok(())
}

pub(crate) fn read_checkpointed(
    engine: &EngineInner,
    index: &IndexState,
    partition: u32,
) -> Result<CheckpointedPartition> {
    let Some(log) = index.log() else {
        return Err(unreadable(index, partition, "the engine keeps no files"));
    };
    let backing = log.backing();
    let metadata = log.metadata(index);
    let stored = recovered_index(engine, &metadata)?;
    let pinned = match read_manifest(backing.files(), &index.name)? {
        Some(DecodedManifest::Current(_)) => Some(backing.pin_checkpoint(&index.name)?),
        Some(DecodedManifest::Earlier(_)) => {
            return Err(unreadable(
                index,
                partition,
                "its checkpoint has the layout of an earlier release",
            ));
        }
        None => None,
    };
    let manifest = pinned.as_ref().map(|pinned| &pinned.manifest);
    if let Some(manifest) = manifest {
        let ids = manifest.partitions.iter().map(|entry| entry.partition_id);
        grow_partitions(&stored, manifest.partitions.len(), ids)?;
        let listed = manifest
            .partitions
            .iter()
            .find(|entry| entry.partition_id == partition);
        if let Some(entry) = listed {
            load_partition(backing, &stored, entry, &manifest.schema)?;
        }
    }
    let checkpoint = manifest.map_or(&[][..], |manifest| manifest.checkpoint.as_slice());
    let uuid = metadata.index_uuid().unwrap_or_default().to_string();
    let copy = ReplicatedCopy::loaded(&stored, uuid, None, checkpoint)?;
    let partitions = stored.partitions();
    let Some(held) = partitions.get(partition as usize) else {
        return Err(unreadable(index, partition, "its checkpoint lacks it"));
    };
    let snapshot = held.snapshot();
    let mut documents = Vec::new();
    {
        let mut records = copy.partition(&index.name, partition)?;
        for entry in &snapshot.segments {
            for ordinal in entry.live_ordinals() {
                let id = entry.id_of(ordinal)?.into_owned();
                let Some(document) = stored.full_document(&id)? else {
                    return Err(unreadable(index, partition, "a stored document is missing"));
                };
                records.hold_saved(&id, entry, ordinal)?;
                documents.push((id, document));
            }
        }
    }
    if let Some(manifest) = manifest {
        attach_checkpoint_vectors(backing, &stored, manifest, &mut documents)?;
    }
    if let Some(pinned) = &pinned {
        pinned.require_unreplaced()?;
    }
    let covered = covered_by(checkpoint, partition);
    drop(partitions);
    Ok(CheckpointedPartition {
        stored,
        copy,
        documents,
        covered,
        _pinned: pinned,
    })
}

pub(crate) fn checkpoint_moved(
    index: &IndexState,
    partition: u32,
    read: &CheckpointedPartition,
) -> Result<bool> {
    let Some(log) = index.log() else {
        return Ok(true);
    };
    let current = match read_manifest(log.backing().files(), &index.name)? {
        Some(DecodedManifest::Current(manifest)) => covered_by(&manifest.checkpoint, partition),
        Some(DecodedManifest::Earlier(_)) => return Ok(true),
        None => None,
    };
    Ok(current != read.covered)
}

/// Replays the partition's write-ahead log onto `read` while the caller holds the write lock, leaving the index as
/// it stands. The partition's log closes, and the replay cuts a torn record off the end of its active segment as
/// recovery does, so that the caller resumes the log from what the replay read.
pub(crate) fn stored_partition(
    read: CheckpointedPartition,
    index: &IndexState,
    partition: u32,
) -> Result<StoredPartition> {
    let CheckpointedPartition {
        stored,
        copy,
        mut documents,
        covered,
        _pinned,
    } = read;
    let mut replayed = None;
    let mut written = Vec::new();
    let mut seen = HashSet::new();
    if let Some(store) = index.log().and_then(|log| log.log_store()) {
        let _writer = stored.write_lock();
        let mut visit = |entry: LogEntry| {
            if seen.insert(entry.document_id.clone()) {
                written.push(entry.document_id.clone());
            }
            copy.replayed(partition, &entry);
            apply_entry(&stored, entry)
        };
        let partition_log = ReplicatedLog {
            store,
            index_name: &index.name,
            partition,
        };
        let after_seq_no = covered.map_or(0, |entry| entry.last_seq_no);
        replayed = Some(partition_log.replay_repaired(after_seq_no, &mut visit)?);
    }
    documents.retain(|(id, _)| !seen.contains(id));
    for id in written {
        if let Some(document) = stored.full_document(&id)? {
            documents.push((id, document));
        }
    }
    let copy = copy.partition(&index.name, partition)?.clone();
    Ok(StoredPartition {
        documents,
        copy,
        replayed,
    })
}
