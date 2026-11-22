use super::build::recovered_index;
use super::load::load_current_checkpoint;
use super::recover::apply_entry;
use crate::durability::checkpoint_files::read_manifest;
use crate::durability::log_reader::{LogVisit, replay_partition_log};
use crate::engine::EngineInner;
use crate::engine::index::IndexState;
use crate::engine::replication::copy_state::{PartitionCopy, ReplicatedCopy};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::manifest::DecodedManifest;
use crate::format::wal::LogEntry;
use crate::value::{Map, Value};

/// One partition as its checkpoint and its write-ahead log hold it.
pub(crate) struct StoredPartition {
    pub(crate) documents: Vec<(String, Map)>,
    pub(crate) copy: PartitionCopy,
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

/// Reads one partition of a cluster copy from its checkpoint and its write-ahead log, leaving the files and the
/// index as they stand, while the caller holds the write lock.
pub(crate) fn stored_partition(
    engine: &EngineInner,
    index: &IndexState,
    partition: u32,
) -> Result<StoredPartition> {
    let Some(log) = index.log() else {
        return Err(unreadable(index, partition, "the engine keeps no files"));
    };
    let backing = log.backing();
    let metadata = log.metadata(index);
    let stored = recovered_index(engine, &metadata)?;
    let checkpoint = match read_manifest(backing.files(), &index.name)? {
        Some(DecodedManifest::Current(manifest)) => {
            load_current_checkpoint(backing, &stored, &manifest)?;
            manifest.checkpoint
        }
        Some(DecodedManifest::Earlier(_)) => {
            return Err(unreadable(
                index,
                partition,
                "its checkpoint has the layout of an earlier release",
            ));
        }
        None => Vec::new(),
    };
    let uuid = metadata.index_uuid().unwrap_or_default().to_string();
    let copy = ReplicatedCopy::loaded(&stored, uuid, Vec::new(), &checkpoint)?;
    if let Some(store) = log.log_store() {
        let _writer = stored.write_lock();
        let mut visit = |entry: LogEntry| {
            copy.replayed(partition, &entry);
            apply_entry(&stored, entry)
        };
        let after_seq_no = checkpoint
            .iter()
            .find(|entry| entry.partition_id == partition)
            .map_or(0, |entry| entry.last_seq_no);
        replay_partition_log(
            &store.inner.directory,
            &index.name,
            partition,
            LogVisit {
                after_seq_no,
                up_to_seq_no: u64::MAX,
                visit: &mut visit,
            },
            false,
        )?;
    }
    let partitions = stored.partitions();
    let Some(held) = partitions.get(partition as usize) else {
        return Err(unreadable(index, partition, "its checkpoint lacks it"));
    };
    let snapshot = held.snapshot();
    let mut documents = Vec::new();
    for entry in &snapshot.segments {
        for ordinal in entry.live_ordinals() {
            let id = entry.id_of(ordinal)?.into_owned();
            let Some(document) = stored.full_document(&id)? else {
                return Err(unreadable(index, partition, "a stored document is missing"));
            };
            documents.push((id, document));
        }
    }
    let copy = copy.partition(&index.name, partition)?.clone();
    Ok(StoredPartition { documents, copy })
}
