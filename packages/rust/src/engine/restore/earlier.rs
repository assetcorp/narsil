use std::collections::HashMap;
use std::io::{self, Read};

use super::install::{Staging, activate, install};
use super::prepare::{PreparedIndex, prepare_restored_index, snapshot_rejection};
use super::validate::validate_staged_checkpoint;
use crate::engine::EngineInner;
use crate::engine::durable::archive::archive_checkpoint;
use crate::engine::durable::load::grow_partitions;
use crate::engine::vectors::paths::set_value_at;
use crate::engine::writes::replay_index;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::earlier_payload::index_snapshot::EarlierIndexSnapshot;
use crate::format::earlier_payload::{decode_index_snapshot, open_index_snapshot};
use crate::format::envelope::{HEADER_BYTES, MAX_FILE_BYTES, read_header};
use crate::format::manifest::SegmentManifest;
use crate::index::constants::ARRAY_POSITION_GAP;
use crate::value::{Map, Value};

type VectorsByDocument = HashMap<String, Vec<(String, Vec<f32>)>>;

fn load_failed(message: String) -> NarsilError {
    NarsilError::new(ErrorCode::PERSISTENCE_LOAD_FAILED, message)
}

fn read_failure(error: io::Error) -> NarsilError {
    load_failed(format!("The snapshot could not be read: {error}"))
}

fn read_into(data: &mut dyn Read, limit: u64, bytes: &mut Vec<u8>) -> Result<()> {
    Read::take(data, limit)
        .read_to_end(bytes)
        .map(|_| ())
        .map_err(read_failure)
}

/// Reads a release 0.3 snapshot file whose first bytes `head` holds, refusing a file above the file size limit, a
/// file that ends before the payload that its header declares, and bytes after that payload.
pub(super) fn read_earlier_file(head: Vec<u8>, data: &mut dyn Read) -> Result<Vec<u8>> {
    let mut bytes = head;
    let header_rest = (HEADER_BYTES as u64).saturating_sub(bytes.len() as u64);
    read_into(data, header_rest, &mut bytes)?;
    let header = read_header(&bytes)?;
    let length = HEADER_BYTES as u64 + u64::from(header.payload_length);
    if length > MAX_FILE_BYTES {
        return Err(load_failed(format!(
            "The snapshot declares {length} bytes, above the file size limit of {MAX_FILE_BYTES}"
        )));
    }
    read_into(data, length - bytes.len() as u64, &mut bytes)?;
    if (bytes.len() as u64) < length {
        return Err(load_failed(
            "The snapshot ends before the payload its header declares".to_string(),
        ));
    }
    let mut trailing = Vec::new();
    read_into(data, 1, &mut trailing)?;
    if !trailing.is_empty() {
        return Err(load_failed(
            "The snapshot holds bytes after the payload its header declares".to_string(),
        ));
    }
    Ok(bytes)
}

fn configuration_of(snapshot: &EarlierIndexSnapshot) -> Map {
    let mut payload = snapshot.settings.clone();
    payload.insert("schema", Value::Object(snapshot.schema.clone()));
    payload.insert("language", Value::String(snapshot.language.clone()));
    payload
}

fn prepared_as_analysed_now(
    engine: &EngineInner,
    name: &str,
    payload: &Map,
) -> Result<PreparedIndex> {
    let mut prepared = prepare_restored_index(engine, name, payload, &snapshot_rejection)?;
    let language = prepared.index.analyser().language().clone();
    prepared.recorded.analysis_revision = Some(language.revision().to_string());
    prepared.recorded.array_position_gap = Some(f64::from(ARRAY_POSITION_GAP));
    Ok(prepared)
}

fn vectors_of(snapshot: &mut EarlierIndexSnapshot) -> VectorsByDocument {
    let mut by_document = VectorsByDocument::new();
    for (field_path, parts) in std::mem::take(&mut snapshot.vector_indexes) {
        for part in parts {
            let dimension = part.dimension;
            for (at, id) in part.doc_ids.into_iter().enumerate() {
                let start = at.saturating_mul(dimension).min(part.vectors.len());
                let end = start.saturating_add(dimension).min(part.vectors.len());
                let fields = by_document.entry(id).or_default();
                fields.retain(|(path, _)| path != &field_path);
                fields.push((field_path.clone(), part.vectors[start..end].to_vec()));
            }
        }
    }
    by_document
}

fn insert_documents(prepared: &PreparedIndex, mut snapshot: EarlierIndexSnapshot) -> Result<()> {
    let index = &prepared.index;
    let count = snapshot.partitions.len();
    if count > 0 {
        grow_partitions(index, count, 0..count as u32)?;
    }
    let mut vectors = vectors_of(&mut snapshot);
    for partition in snapshot.partitions {
        for (id, mut document) in partition.documents {
            for (path, values) in vectors.remove(&id).unwrap_or_default() {
                let numbers = values
                    .into_iter()
                    .map(|value| Value::Number(f64::from(value)));
                set_value_at(&mut document, &path, Value::Array(numbers.collect()));
            }
            replay_index(index, &id, document)?;
        }
    }
    Ok(())
}

fn stage_built(prepared: &PreparedIndex, staging: &Staging<'_>) -> Result<SegmentManifest> {
    let checkpoint = archive_checkpoint(&prepared.index)?;
    let store = staging.store();
    let mut directories = Vec::new();
    for file in checkpoint.manifest.file_refs() {
        let mut bytes = Vec::new();
        checkpoint.copy_file(file, &mut bytes)?;
        let mut sink = store.begin_file(&file.key)?;
        sink.write_bytes(&bytes)?;
        if let Some(directory) = store.finish_file(sink)?
            && !directories.contains(&directory)
        {
            directories.push(directory);
        }
    }
    store.sync_directories(&directories)?;
    validate_staged_checkpoint(&staging.source(), &checkpoint.manifest)?;
    Ok(checkpoint.manifest)
}

/// Restores the index snapshot that the snapshot operation of engine 0.3.0 returned: inserts its documents and
/// vectors as new writes under the index's analysis, then, for a durable engine, saves the result as a
/// checkpoint of the current layout and loads the index from it, as every Narsil engine restores such a file.
pub(super) fn restore_earlier(
    engine: &EngineInner,
    name: &str,
    bytes: &[u8],
    staging: &mut Staging<'_>,
) -> Result<()> {
    let snapshot = decode_index_snapshot(&open_index_snapshot(bytes)?)?;
    let payload = configuration_of(&snapshot);
    let built = prepared_as_analysed_now(engine, name, &payload)?;
    insert_documents(&built, snapshot)?;
    if matches!(staging, Staging::Memory(_)) {
        let PreparedIndex { index, recorded } = built;
        return activate(engine, index, &recorded, None, staging);
    }
    let manifest = stage_built(&built, staging)?;
    drop(built);
    let fresh = prepared_as_analysed_now(engine, name, &payload)?;
    install(engine, fresh, &manifest, staging)
}
