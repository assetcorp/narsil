mod decode;
mod encode;

use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::envelope::{Compression, Expectation, open_checksummed};
use crate::format::layout::SEGMENTS_MARKER;
use crate::format::manifest_refs::{FileRef, VectorFieldRef, invalid_manifest};
use crate::value::{Map, Value, decode_value};

pub(crate) use decode::{decode_manifest_payload, schema_and_language};
pub(crate) use encode::{encode_manifest, manifest_to_wire};

pub(crate) const SEGMENT_MANIFEST_VERSION: u8 = 7;
pub(crate) const EARLIER_SEGMENT_MANIFEST_VERSION: u8 = 6;
pub(crate) const MANIFEST_ENVELOPE_VERSION: u8 = 2;
pub(crate) const MAX_SEGMENTS_PER_PARTITION: usize = 65_536;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TermStart {
    pub(crate) primary_term: u64,
    pub(crate) first_seq_no: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PartitionCheckpoint {
    pub(crate) partition_id: u32,
    pub(crate) last_seq_no: u64,
    pub(crate) primary_term: u64,
    pub(crate) term_history: Option<Vec<TermStart>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SegmentRef {
    pub(crate) id: u64,
    pub(crate) file: FileRef,
    pub(crate) document_count: u32,
    pub(crate) tombstone_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PartitionEntry {
    pub(crate) partition_id: u32,
    pub(crate) next_segment_id: u64,
    pub(crate) segments: Vec<SegmentRef>,
}

/// The segmented checkpoint manifest of one index.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SegmentManifest {
    pub(crate) schema: Map,
    pub(crate) language: String,
    pub(crate) analysis_generation: Option<u64>,
    pub(crate) checkpoint: Vec<PartitionCheckpoint>,
    pub(crate) partitions: Vec<PartitionEntry>,
    pub(crate) vectors: Vec<VectorFieldRef>,
}

impl SegmentManifest {
    pub(crate) fn file_refs(&self) -> Vec<&FileRef> {
        let mut refs = Vec::new();
        for partition in &self.partitions {
            refs.extend(partition.segments.iter().map(|segment| &segment.file));
        }
        for field in &self.vectors {
            refs.extend(field.files.iter().map(|file| &file.file));
            refs.extend(field.graph_parts.iter());
        }
        refs
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum DecodedManifest {
    Current(SegmentManifest),
    Earlier(Map),
}

pub(crate) fn open_manifest_payload(data: &[u8]) -> Result<(Compression, Map)> {
    let expected = Expectation {
        version: MANIFEST_ENVELOPE_VERSION,
        what: "segment manifest",
        allows_compression: true,
    };
    let (header, payload) = open_checksummed(data, &expected)?;
    match decode_value(payload.bytes())? {
        Value::Object(map) => Ok((header.compression(), map)),
        _ => Err(invalid_manifest("is not a map")),
    }
}

pub(crate) fn listed_keys(raw: &Map) -> Vec<String> {
    let mut keys = Vec::new();
    if let Some(Value::Array(partitions)) = raw.get("partitions") {
        for partition in partitions {
            let Some(Value::Array(segments)) =
                partition.as_object().and_then(|map| map.get("segments"))
            else {
                continue;
            };
            for segment in segments {
                if let Some(key) = segment
                    .as_object()
                    .and_then(|map| map.get("key"))
                    .and_then(Value::as_str)
                {
                    keys.push(key.to_string());
                }
            }
        }
    }
    if let Some(Value::Array(fields)) = raw.get("vectors") {
        for field in fields {
            let Some(map) = field.as_object() else {
                continue;
            };
            for list in [map.get("files"), map.get("graphParts")] {
                let Some(Value::Array(files)) = list else {
                    continue;
                };
                for file in files {
                    if let Some(key) = file
                        .as_object()
                        .and_then(|map| map.get("key"))
                        .and_then(Value::as_str)
                    {
                        keys.push(key.to_string());
                    }
                }
            }
        }
    }
    keys
}
/// Returns the index name that the first listed key starts with, as a reader of an archive or a manifest file does.
pub(crate) fn source_index_name(keys: &[String]) -> Result<String> {
    let Some(first) = keys.first() else {
        return Ok("archive".to_string());
    };
    match first.find(SEGMENTS_MARKER) {
        Some(at) if at > 0 => Ok(first[..at].to_string()),
        _ => Err(NarsilError::new(
            ErrorCode::PERSISTENCE_LOAD_FAILED,
            format!(
                "Invalid snapshot archive: the manifest lists the key \"{first}\" outside any index"
            ),
        )),
    }
}

pub(crate) fn decode_manifest_file(data: &[u8]) -> Result<(Compression, String, DecodedManifest)> {
    let (compression, raw) = open_manifest_payload(data)?;
    let index_name = source_index_name(&listed_keys(&raw))?;
    let decoded = decode_manifest_payload(&raw, &index_name)?;
    Ok((compression, index_name, decoded))
}
