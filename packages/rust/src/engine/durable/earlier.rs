use super::backing::Backing;
use super::load::{dead_count, grow_partitions, load_failed, remove_replaced, vectors_location};
use crate::durability::earlier::{EarlierManifest, EarlierPartitionEntry, EarlierVectorFieldRef};
use crate::engine::index::IndexState;
use crate::engine::writes::place_document;
use crate::error::Result;
use crate::format::earlier_payload::decode_v2_documents;
use crate::format::envelope::{Expectation, MAX_FILE_BYTES, open_checksummed};
use crate::format::graph_part::decode_earlier_graph_payload;
use crate::format::manifest::{PartitionCheckpoint, PartitionEntry, SegmentManifest};
use crate::format::manifest_refs::{FileRef, VectorFieldRef, VectorFileRef};
use crate::format::metadata::open_lenient_envelope;
use crate::format::vector_file::{VECTOR_FILE_ENVELOPE_VERSION, decode_vector_file};
use crate::value::{Map, Value, decode_value};
use crate::vector::restore::{CheckpointRestoreShape, LoadedVectorFile};

const EARLIER_FILE_MAX_ENVELOPE_VERSION: u8 = 2;

/// What an earlier layout held: the log position that its checkpoint covers, and the manifest that the upgrade
/// checkpoint starts from, which keeps each earlier vector file and continues each numbering.
pub(crate) struct EarlierLoaded {
    pub(crate) checkpoint: Vec<PartitionCheckpoint>,
    pub(crate) prior: SegmentManifest,
}

fn read_earlier_bytes(store: &Backing, key: &str, missing: String) -> Result<Vec<u8>> {
    store
        .files()
        .read_within(key, MAX_FILE_BYTES)?
        .ok_or_else(|| load_failed(missing))
}

/// Reads an earlier vector file or graph file, whose format requires a checksum, and returns the reference that
/// the upgrade manifest lists for it with its payload.
fn read_earlier_vector_file(
    store: &Backing,
    key: &str,
    kind: &str,
    allows_compression: bool,
) -> Result<(FileRef, Vec<u8>)> {
    let bytes = read_earlier_bytes(store, key, format!("The {kind} \"{key}\" is missing"))?;
    let what = format!("{kind} \"{key}\"");
    let expected = Expectation {
        version: VECTOR_FILE_ENVELOPE_VERSION,
        what: &what,
        allows_compression,
    };
    let (header, payload) = open_checksummed(&bytes, &expected)?;
    let reference = FileRef {
        key: key.to_string(),
        bytes: bytes.len() as u64,
        checksum: header.checksum,
        head: None,
    };
    Ok((reference, payload.bytes().to_vec()))
}

/// Opens the container of an earlier segment file: a partition payload and the IDs that it removes.
fn earlier_segment(store: &Backing, key: &str) -> Result<(Vec<u8>, Vec<String>)> {
    let bytes = read_earlier_bytes(store, key, format!("Segment file \"{key}\" is missing"))?;
    let (_, payload) = open_lenient_envelope(&bytes, EARLIER_FILE_MAX_ENVELOPE_VERSION)?;
    let missing_payload = || load_failed("Segment file is missing its partition payload".into());
    let Value::Object(container) = decode_value(&payload)? else {
        return Err(missing_payload());
    };
    let Some(Value::Bytes(partition)) = container.get("payload") else {
        return Err(missing_payload());
    };
    let tombstones = match container.get("tombstones") {
        None => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| item.as_str().map(str::to_string))
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| load_failed("Segment file has a malformed tombstone list".into()))?,
        Some(_) => {
            return Err(load_failed(
                "Segment file has a malformed tombstone list".into(),
            ));
        }
    };
    Ok((partition.clone(), tombstones))
}

/// Adds a segment's field types to the types that the partition's earlier segments agree on, refusing a field
/// that two segments give different types.
fn add_segment_schema(agreed: &mut Map, schema: &Map) -> Result<()> {
    for (field, found) in schema.iter() {
        if let Some(existing) = agreed.get(field)
            && existing != found
        {
            return Err(load_failed(format!(
                "Segment schemas disagree on field \"{field}\": \"{}\" vs \"{}\"",
                existing.as_str().unwrap_or_default(),
                found.as_str().unwrap_or_default()
            )));
        }
        agreed.insert(field.clone(), found.clone());
    }
    Ok(())
}

fn load_partition(
    store: &Backing,
    index: &IndexState,
    entry: &EarlierPartitionEntry,
) -> Result<()> {
    let count = index.partitions().len();
    if entry.partition_id as usize >= count {
        return Err(load_failed(format!(
            "Segment manifest references partition {} beyond the partition count {count}",
            entry.partition_id
        )));
    }
    let mut agreed = Map::new();
    for listed in &entry.segments {
        let (payload, tombstones) = earlier_segment(store, &listed.key)?;
        let stored = decode_v2_documents(&payload)?;
        add_segment_schema(&mut agreed, &stored.schema)?;
        let held = stored.documents.iter().map(|(id, _)| id.as_str());
        remove_replaced(index, tombstones.iter().map(String::as_str).chain(held))?;
        for (id, document) in stored.documents {
            place_document(index, entry.partition_id as usize, &id, document)?;
        }
    }
    let partitions = index.partitions();
    if let Some(partition) = partitions.get(entry.partition_id as usize) {
        partition.write(|snapshot| {
            snapshot.next_segment_id = snapshot.next_segment_id.max(entry.next_segment_id);
        });
    }
    Ok(())
}

fn load_vector_field(
    store: &Backing,
    index: &IndexState,
    listed: &EarlierVectorFieldRef,
) -> Result<Option<VectorFieldRef>> {
    let Some(field) = index.vectors.field(&listed.field_path) else {
        return Ok(None);
    };
    let graph = match &listed.graph_key {
        None => None,
        Some(key) => {
            let (_, payload) = read_earlier_vector_file(store, key, "graph file", true)?;
            Some(decode_earlier_graph_payload(&payload)?)
        }
    };
    let live_vectors = listed
        .files
        .iter()
        .map(|file| u64::from(file.count) - dead_count(file.dead.as_deref(), file.count))
        .sum();
    let mut restore = field.begin_restore(CheckpointRestoreShape {
        live_vectors,
        holds_graph: listed.graph_key.is_some(),
        graph,
    });
    let mut kept = Vec::with_capacity(listed.files.len());
    for file in &listed.files {
        let (reference, payload) =
            read_earlier_vector_file(store, &file.key, "vector file", false)?;
        let decoded = decode_vector_file(&payload)?;
        if decoded.doc_ids.len() != file.count as usize {
            return Err(load_failed(format!(
                "The vector file \"{}\" holds {} vectors where the manifest counts {}",
                file.key,
                decoded.doc_ids.len(),
                file.count
            )));
        }
        let location = vectors_location(store, &file.key, payload.len(), decoded.vectors.len())?;
        restore.add_file(LoadedVectorFile {
            id: file.id,
            key: file.key.clone(),
            file: decoded,
            dead: file.dead.clone(),
            location,
        })?;
        kept.push(VectorFileRef {
            id: file.id,
            file: reference,
            count: file.count,
            dead: file.dead.clone(),
        });
    }
    restore.finish()?;
    Ok(Some(VectorFieldRef {
        field_path: listed.field_path.clone(),
        next_file_id: listed.next_file_id,
        files: kept,
        graph_generation: listed.graph_generation,
        graph_parts: Vec::new(),
    }))
}

/// Loads the checkpoint of an earlier release's layout: each segment's stored documents, indexed again under the
/// index's analysis in manifest order, then each vector field's files and its one-file graph.
pub(crate) fn load_earlier_checkpoint(
    store: &Backing,
    index: &IndexState,
    manifest: &EarlierManifest,
) -> Result<EarlierLoaded> {
    let ids = manifest.partitions.iter().map(|entry| entry.partition_id);
    grow_partitions(index, manifest.partitions.len(), ids)?;
    for entry in &manifest.partitions {
        load_partition(store, index, entry)?;
    }
    let mut vectors = Vec::new();
    for listed in &manifest.vectors {
        vectors.extend(load_vector_field(store, index, listed)?);
    }
    let partition_count = index.partitions().len();
    let partitions = manifest
        .partitions
        .iter()
        .filter(|entry| (entry.partition_id as usize) < partition_count)
        .map(|entry| PartitionEntry {
            partition_id: entry.partition_id,
            next_segment_id: entry.next_segment_id,
            segments: Vec::new(),
        })
        .collect();
    let prior = SegmentManifest {
        schema: manifest.schema.clone(),
        language: manifest.language.clone(),
        analysis_generation: None,
        checkpoint: Vec::new(),
        partitions,
        vectors,
    };
    Ok(EarlierLoaded {
        checkpoint: manifest.checkpoint.clone(),
        prior,
    })
}
