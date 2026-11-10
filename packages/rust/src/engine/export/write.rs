use std::collections::HashMap;
use std::io::{BufWriter, Write};

use crate::engine::constants::EXPORT_CHUNK_BYTES;
use crate::engine::durable::archive::ArchiveCheckpoint;
use crate::engine::vectors::paths::set_value_at;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::document_export::{document_line, header_line};
use crate::format::keyword_segment::{KEYWORD_SEGMENT_ENVELOPE_VERSION, decode_keyword_segment};
use crate::format::manifest::{PartitionEntry, SegmentRef};
use crate::format::manifest_refs::VectorFileRef;
use crate::format::vector_file::{VECTOR_FILE_ENVELOPE_VERSION, decode_vector_file};
use crate::index::frozen::FrozenSegment;
use crate::value::{Map, Value};

const FLOAT32_BYTES: u64 = 4;

struct VectorLocation<'a> {
    file: &'a VectorFileRef,
    position: u32,
    dimension: u64,
}

type VectorLocations<'a> = Vec<(String, HashMap<String, VectorLocation<'a>>)>;

fn write_failed(error: std::io::Error) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_SAVE_FAILED,
        format!("The document export could not be written: {error}"),
    )
}

fn is_dead(dead: Option<&[u8]>, position: u32) -> bool {
    let at = position as usize;
    dead.and_then(|bits| bits.get(at >> 3))
        .is_some_and(|byte| (byte >> (at & 7)) & 1 == 1)
}

fn locate_vectors(checkpoint: &ArchiveCheckpoint) -> Result<VectorLocations<'_>> {
    let mut located = Vec::with_capacity(checkpoint.manifest.vectors.len());
    for field in &checkpoint.manifest.vectors {
        let mut by_doc_id = HashMap::new();
        for file in &field.files {
            let payload = checkpoint.read_listed(
                &file.file,
                "vector file",
                VECTOR_FILE_ENVELOPE_VERSION,
                false,
            )?;
            let decoded = decode_vector_file(&payload)?;
            for (position, doc_id) in decoded.doc_ids.into_iter().enumerate() {
                let position = u32::try_from(position).unwrap_or(u32::MAX);
                if is_dead(file.dead.as_deref(), position) {
                    continue;
                }
                let location = VectorLocation {
                    file,
                    position,
                    dimension: decoded.dimension as u64,
                };
                by_doc_id.insert(doc_id, location);
            }
        }
        located.push((field.field_path.clone(), by_doc_id));
    }
    Ok(located)
}

fn read_vector(checkpoint: &ArchiveCheckpoint, location: &VectorLocation<'_>) -> Result<Value> {
    let width = location.dimension.saturating_mul(FLOAT32_BYTES);
    let behind = u64::from(location.file.count.saturating_sub(location.position));
    let offset = location
        .file
        .file
        .bytes
        .saturating_sub(behind.saturating_mul(width));
    let bytes = checkpoint.read_range(&location.file.file, offset, width)?;
    let numbers = bytes
        .chunks_exact(FLOAT32_BYTES as usize)
        .map(|chunk| {
            let raw = <[u8; 4]>::try_from(chunk).unwrap_or_default();
            Value::Number(f64::from(f32::from_le_bytes(raw)))
        })
        .collect();
    Ok(Value::Array(numbers))
}

fn read_segment(
    checkpoint: &ArchiveCheckpoint,
    listed: &SegmentRef,
) -> Result<(FrozenSegment, Vec<String>)> {
    let payload = checkpoint.read_listed(
        &listed.file,
        "segment",
        KEYWORD_SEGMENT_ENVELOPE_VERSION,
        true,
    )?;
    let mut segment = decode_keyword_segment(&payload)?;
    let tombstones = std::mem::take(&mut segment.tombstones);
    Ok((FrozenSegment::new(segment), tombstones))
}

fn winners_of(
    checkpoint: &ArchiveCheckpoint,
    partition: &PartitionEntry,
) -> Result<HashMap<String, usize>> {
    let mut winners = HashMap::new();
    for (at, listed) in partition.segments.iter().enumerate() {
        let (segment, tombstones) = read_segment(checkpoint, listed)?;
        for doc_id in &tombstones {
            winners.remove(doc_id);
        }
        for ordinal in 0..segment.capacity() {
            winners.insert(segment.id(ordinal)?.into_owned(), at);
        }
    }
    Ok(winners)
}

fn write_partition(
    checkpoint: &ArchiveCheckpoint,
    partition: &PartitionEntry,
    vectors: &VectorLocations<'_>,
    out: &mut dyn Write,
) -> Result<()> {
    let winners = winners_of(checkpoint, partition)?;
    for (at, listed) in partition.segments.iter().enumerate() {
        let (segment, _) = read_segment(checkpoint, listed)?;
        for ordinal in 0..segment.capacity() {
            let doc_id = segment.id(ordinal)?;
            if winners.get(doc_id.as_ref()) != Some(&at) {
                continue;
            }
            let mut document: Map = segment.document(ordinal)?;
            for (field_path, located) in vectors {
                if let Some(location) = located.get(doc_id.as_ref()) {
                    set_value_at(
                        &mut document,
                        field_path,
                        read_vector(checkpoint, location)?,
                    );
                }
            }
            let line = document_line(&doc_id, &document)?;
            out.write_all(line.as_bytes()).map_err(write_failed)?;
        }
    }
    Ok(())
}

/// Writes a document export of `checkpoint`: the header line that carries `configuration`, then one line for
/// each document that the checkpoint holds, with its vectors, partition by partition in segment order.
pub(crate) fn write_document_export(
    configuration: &Map,
    checkpoint: &ArchiveCheckpoint,
    out: &mut dyn Write,
) -> Result<()> {
    let mut buffered = BufWriter::with_capacity(EXPORT_CHUNK_BYTES, out);
    let header = header_line(configuration)?;
    buffered
        .write_all(header.as_bytes())
        .map_err(write_failed)?;
    let vectors = locate_vectors(checkpoint)?;
    for partition in &checkpoint.manifest.partitions {
        write_partition(checkpoint, partition, &vectors, &mut buffered)?;
    }
    buffered.flush().map_err(write_failed)
}
