use std::sync::Arc;

use super::load_from_files::open_from_files;
use super::load_source::CheckpointSource;
use crate::config::{MAX_PARTITIONS, Storage};
use crate::engine::index::IndexState;
use crate::engine::vectors::paths::{set_value_at, value_at};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::envelope::HEADER_BYTES;
use crate::format::graph_part::{
    GRAPH_PART_ENVELOPE_VERSION, GraphParts, assemble_graph_parts, decode_graph_part,
};
use crate::format::keyword_segment::{KEYWORD_SEGMENT_ENVELOPE_VERSION, decode_keyword_segment};
use crate::format::manifest::{PartitionEntry, SegmentManifest, SegmentRef};
use crate::format::manifest_refs::VectorFieldRef;
use crate::format::paged_segment::PAGED_SEGMENT_ENVELOPE_VERSION;
use crate::format::vector_file::{VECTOR_FILE_ENVELOPE_VERSION, decode_vector_file};
use crate::index::frozen::FrozenSegment;
use crate::index::paged::{PagedListing, open_paged_segment};
use crate::index::partition::{Partition, PartitionSnapshot, in_keyword_batch};
use crate::index::segment::{SegmentData, SegmentEntry};
use crate::util::bytes::float32_array;
use crate::value::{Map, Value};
use crate::vector::restore::{CheckpointRestoreShape, LoadedVectorFile, VectorFileLocation};

pub(super) fn load_failed(message: String) -> NarsilError {
    NarsilError::new(ErrorCode::PERSISTENCE_LOAD_FAILED, message)
}

/// Adds partitions until the index holds every partition that the manifest lists, after refusing a partition
/// numbered 65,536 or higher. An index that an earlier release rebalanced past its `maxPartitions` keeps every
/// partition that it saved.
pub(crate) fn grow_partitions(
    index: &IndexState,
    listed: usize,
    partition_ids: impl Iterator<Item = u32>,
) -> Result<()> {
    let highest = partition_ids
        .map(|id| id as usize)
        .fold(listed.saturating_sub(1), usize::max);
    if highest as u64 >= MAX_PARTITIONS {
        return Err(load_failed(format!(
            "Segment manifest references partition {highest}, beyond the {MAX_PARTITIONS} partitions that an index holds at most"
        )));
    }
    let mut partitions = index.partitions().to_vec();
    while partitions.len() <= highest {
        let snapshot = PartitionSnapshot::new(index.track_positions);
        partitions.push(Arc::new(Partition::new(snapshot)));
    }
    index.replace_partitions(partitions);
    Ok(())
}

fn require_agreed_schema(agreed: &Map, schema: &Map, key: &str) -> Result<()> {
    for (field, found) in schema.iter() {
        if let Some(existing) = agreed.get(field)
            && existing != found
        {
            return Err(load_failed(format!(
                "The segment \"{key}\" gives field \"{field}\" the type \"{}\", while the index gives it \"{}\"",
                found.as_str().unwrap_or_default(),
                existing.as_str().unwrap_or_default()
            )));
        }
    }
    Ok(())
}

/// Removes every copy that an earlier segment holds of a document that `ids` lists.
pub(super) fn remove_replaced<'a>(
    index: &IndexState,
    ids: impl Iterator<Item = &'a str>,
) -> Result<()> {
    let partitions = index.partitions();
    let analyse = |document: &Map| index.index_document(document);
    in_keyword_batch(&partitions, || {
        for id in ids {
            if let Some(at) = index.locate(&partitions, id)? {
                partitions[at].write(|snapshot| snapshot.remove(id, &analyse))?;
            }
        }
        Ok(())
    })
}

fn attach_segment(target: &Partition, id: u64, frozen: Arc<FrozenSegment>) {
    target.write(|snapshot| {
        let added = SegmentEntry::new(id, SegmentData::Frozen(frozen));
        for ordinal in added.live_ordinals() {
            snapshot.stats.add(added.field_lengths_of(ordinal));
        }
        snapshot.segments.push(added);
        snapshot.next_segment_id = snapshot.next_segment_id.max(id.saturating_add(1));
    });
}

/// Reports whether a listed segment is a paged segment that the index reads from its file, which an index whose
/// text stays on disk does for every segment whose header gives the paged envelope format.
fn holds_paged_text(store: &dyn CheckpointSource, index: &IndexState, key: &str) -> Result<bool> {
    if index.config().text_storage != Some(Storage::Disk) {
        return Ok(false);
    }
    Ok(store.envelope_version(key)? == Some(PAGED_SEGMENT_ENVELOPE_VERSION))
}

/// Opens a paged segment on its file, removes from the earlier segments the documents that its head lists as
/// tombstones, and attaches it where it holds documents, leaving its IDs in its file unread.
fn load_paged_segment(
    store: &dyn CheckpointSource,
    index: &IndexState,
    target: &Partition,
    listed: &SegmentRef,
    schema: &Map,
) -> Result<()> {
    let key = &listed.file.key;
    let Some(path) = store.path_of(key)? else {
        return Err(load_failed(format!(
            "The segment \"{key}\" is not in a directory that the index reads by position"
        )));
    };
    let listing = PagedListing {
        key: key.clone(),
        path,
        bytes: listed.file.bytes,
        checksum: listed.file.checksum,
    };
    let (mut resident, sections) = open_paged_segment(&listing)?;
    require_agreed_schema(schema, &resident.schema, key)?;
    let tombstones = std::mem::take(&mut resident.tombstones);
    let holds_documents = resident.document_count > 0;
    let frozen = Arc::new(FrozenSegment::from_paged(resident, sections));
    remove_replaced(index, tombstones.iter().map(String::as_str))?;
    if holds_documents {
        attach_segment(target, listed.id, frozen);
    }
    Ok(())
}

fn load_partition(
    store: &dyn CheckpointSource,
    index: &IndexState,
    entry: &PartitionEntry,
    schema: &Map,
) -> Result<()> {
    let partitions = index.partitions();
    let Some(target) = partitions.get(entry.partition_id as usize) else {
        return Err(load_failed(format!(
            "Segment manifest references partition {} beyond the partition count {}",
            entry.partition_id,
            partitions.len()
        )));
    };
    for listed in &entry.segments {
        let key = &listed.file.key;
        if holds_paged_text(store, index, key)? {
            load_paged_segment(store, index, target, listed, schema)?;
            continue;
        }
        let payload = store.read_listed(
            &listed.file,
            "segment",
            KEYWORD_SEGMENT_ENVELOPE_VERSION,
            true,
        )?;
        let mut segment = decode_keyword_segment(&payload)?;
        require_agreed_schema(schema, &segment.schema, key)?;
        let tombstones = std::mem::take(&mut segment.tombstones);
        let holds_documents = segment.document_count > 0;
        let frozen = Arc::new(FrozenSegment::new(segment));
        let held = frozen.ids_in_order().map(|(_, id)| id);
        remove_replaced(index, tombstones.iter().map(String::as_str).chain(held))?;
        if holds_documents {
            attach_segment(target, listed.id, frozen);
        }
    }
    target.write(|snapshot| {
        snapshot.next_segment_id = snapshot.next_segment_id.max(entry.next_segment_id);
    });
    Ok(())
}

pub(super) fn dead_count(dead: Option<&[u8]>, count: u32) -> u64 {
    let Some(bits) = dead else {
        return 0;
    };
    (0..count as usize)
        .filter(|&position| {
            bits.get(position >> 3)
                .is_some_and(|byte| (byte >> (position & 7)) & 1 == 1)
        })
        .count() as u64
}

pub(super) fn vectors_location(
    store: &dyn CheckpointSource,
    key: &str,
    payload_bytes: usize,
    vector_count: usize,
) -> Result<Option<VectorFileLocation>> {
    let Some(path) = store.path_of(key)? else {
        return Ok(None);
    };
    let vector_bytes = (vector_count as u64).saturating_mul(4);
    Ok(Some(VectorFileLocation {
        path,
        vectors_offset: (HEADER_BYTES as u64 + payload_bytes as u64).saturating_sub(vector_bytes),
    }))
}

pub(super) fn read_graph_parts(
    store: &dyn CheckpointSource,
    listed: &VectorFieldRef,
) -> Result<Option<GraphParts>> {
    let mut parts = Vec::with_capacity(listed.graph_parts.len());
    for part in &listed.graph_parts {
        let payload = store.read_listed(part, "graph part", GRAPH_PART_ENVELOPE_VERSION, true)?;
        let decoded = decode_graph_part(&payload)?;
        if decoded.field_name != listed.field_path {
            return Err(load_failed(format!(
                "The graph part \"{}\" names field \"{}\" where the manifest lists \"{}\"",
                part.key, decoded.field_name, listed.field_path
            )));
        }
        parts.push(decoded);
    }
    if parts.is_empty() {
        return Ok(None);
    }
    assemble_graph_parts(parts).map(Some)
}

fn load_vector_field(
    store: &dyn CheckpointSource,
    index: &IndexState,
    listed: &VectorFieldRef,
) -> Result<()> {
    let Some(field) = index.vectors.field(&listed.field_path) else {
        return Ok(());
    };
    if open_from_files(store, field, listed)? {
        return Ok(());
    }
    let graph = read_graph_parts(store, listed)?;
    let live_vectors = listed
        .files
        .iter()
        .map(|file| u64::from(file.count) - dead_count(file.dead.as_deref(), file.count))
        .sum();
    let mut restore = field.begin_restore(CheckpointRestoreShape {
        live_vectors,
        holds_graph: !listed.graph_parts.is_empty(),
        graph,
    });
    for file in &listed.files {
        let key = &file.file.key;
        let payload = store.read_listed(
            &file.file,
            "vector file",
            VECTOR_FILE_ENVELOPE_VERSION,
            false,
        )?;
        let decoded = decode_vector_file(&payload)?;
        if decoded.doc_ids.len() != file.count as usize {
            return Err(load_failed(format!(
                "The vector file \"{key}\" holds {} vectors where the manifest counts {}",
                decoded.doc_ids.len(),
                file.count
            )));
        }
        if decoded.field_name != listed.field_path {
            return Err(load_failed(format!(
                "The vector file \"{key}\" names field \"{}\" where the manifest lists \"{}\"",
                decoded.field_name, listed.field_path
            )));
        }
        let location = vectors_location(store, key, payload.len(), decoded.vectors.len())?;
        restore.add_file(LoadedVectorFile {
            id: file.id,
            key: key.clone(),
            file: decoded,
            dead: file.dead.clone(),
            location,
        })?;
    }
    restore.finish()
}

/// Loads a checkpoint of the current layout into an empty index: each partition's segments in manifest order, so
/// that a later segment's copy of a document and its tombstones replace what an earlier segment holds, then each
/// vector field's files and graph.
pub(crate) fn load_current_checkpoint(
    store: &dyn CheckpointSource,
    index: &IndexState,
    manifest: &SegmentManifest,
) -> Result<()> {
    let ids = manifest.partitions.iter().map(|entry| entry.partition_id);
    grow_partitions(index, manifest.partitions.len(), ids)?;
    for entry in &manifest.partitions {
        load_partition(store, index, entry, &manifest.schema)?;
    }
    for listed in &manifest.vectors {
        load_vector_field(store, index, listed)?;
    }
    Ok(())
}

/// Turns each vector field that a replayed document holds as raw little-endian float32 bytes back into a list of
/// numbers, refusing a field whose byte length is not a multiple of 4.
pub(crate) fn restore_vector_bytes(index: &IndexState, document: &mut Map) -> Result<()> {
    for entry in index.vectors.fields() {
        let Some(Value::Bytes(bytes)) = value_at(document, &entry.path) else {
            continue;
        };
        if !bytes.len().is_multiple_of(4) {
            return Err(load_failed(format!(
                "Vector field \"{}\" has invalid byte length {} (must be divisible by 4)",
                entry.path,
                bytes.len()
            )));
        }
        let numbers = float32_array(bytes);
        set_value_at(document, &entry.path, numbers);
    }
    Ok(())
}
