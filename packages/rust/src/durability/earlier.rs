use std::collections::BTreeSet;

use crate::error::Result;
use crate::format::manifest::{MAX_SEGMENTS_PER_PARTITION, PartitionCheckpoint};
use crate::format::manifest_refs::{
    VECTOR_FILE_MAX_VECTORS, dead_bytes_for, id_of, invalid_manifest, sequence_of, uint32_of,
};
use crate::schema::require_valid_field_types;
use crate::value::{Map, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EarlierSegmentRef {
    pub(crate) id: u64,
    pub(crate) key: String,
    pub(crate) document_count: u32,
    pub(crate) tombstone_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EarlierPartitionEntry {
    pub(crate) partition_id: u32,
    pub(crate) next_segment_id: u64,
    pub(crate) segments: Vec<EarlierSegmentRef>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EarlierVectorFileRef {
    pub(crate) id: u64,
    pub(crate) key: String,
    pub(crate) count: u32,
    pub(crate) dead: Option<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EarlierVectorFieldRef {
    pub(crate) field_path: String,
    pub(crate) next_file_id: u64,
    pub(crate) files: Vec<EarlierVectorFileRef>,
    pub(crate) graph_generation: u64,
    pub(crate) graph_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct EarlierManifest {
    pub(crate) schema: Map,
    pub(crate) language: String,
    pub(crate) checkpoint: Vec<PartitionCheckpoint>,
    pub(crate) partitions: Vec<EarlierPartitionEntry>,
    pub(crate) vectors: Vec<EarlierVectorFieldRef>,
}

impl EarlierManifest {
    pub(crate) fn referenced_keys(&self) -> BTreeSet<String> {
        let mut keys = BTreeSet::new();
        for partition in &self.partitions {
            keys.extend(partition.segments.iter().map(|segment| segment.key.clone()));
        }
        for field in &self.vectors {
            keys.extend(field.files.iter().map(|file| file.key.clone()));
            if let Some(graph) = &field.graph_key {
                keys.insert(graph.clone());
            }
        }
        keys
    }
}

fn key_of(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(key)) if !key.is_empty() && !key.contains('\0') => Some(key.clone()),
        _ => None,
    }
}

fn checkpoint_of(raw: Option<&Value>) -> Vec<PartitionCheckpoint> {
    let Some(Value::Array(entries)) = raw else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|entry| {
            let map = entry.as_object()?;
            Some(PartitionCheckpoint {
                partition_id: uint32_of(map.get("partitionId"))?,
                last_seq_no: sequence_of(map.get("lastSeqNo"))?,
                primary_term: sequence_of(map.get("primaryTerm"))?,
                term_history: None,
            })
        })
        .collect()
}

fn segments_of(raw: Option<&Value>) -> Result<Vec<EarlierSegmentRef>> {
    let segments = match raw {
        None => return Ok(Vec::new()),
        Some(Value::Array(segments)) if segments.len() <= MAX_SEGMENTS_PER_PARTITION => segments,
        Some(_) => return Err(invalid_manifest("has malformed segment references")),
    };
    let mut seen = BTreeSet::new();
    let mut out = Vec::with_capacity(segments.len());
    for segment in segments {
        let map = segment.as_object();
        let parsed = map.and_then(|map| {
            Some(EarlierSegmentRef {
                id: id_of(map.get("id"))?,
                key: key_of(map.get("key"))?,
                document_count: uint32_of(map.get("docCount"))?,
                tombstone_count: uint32_of(map.get("tombstoneCount"))?,
            })
        });
        let Some(parsed) = parsed.filter(|parsed| seen.insert(parsed.id)) else {
            return Err(invalid_manifest("has an invalid segment reference"));
        };
        out.push(parsed);
    }
    Ok(out)
}

fn partitions_of(raw: Option<&Value>) -> Result<Vec<EarlierPartitionEntry>> {
    let Some(Value::Array(entries)) = raw else {
        return Err(invalid_manifest("is missing partition entries"));
    };
    let mut out = Vec::with_capacity(entries.len());
    for entry in entries {
        let Some((map, partition_id)) = entry
            .as_object()
            .and_then(|map| uint32_of(map.get("partitionId")).map(|id| (map, id)))
        else {
            return Err(invalid_manifest("has a partition without a valid id"));
        };
        let segments = segments_of(map.get("segments"))?;
        let next_segment_id = id_of(map.get("nextSegmentId"))
            .filter(|next| segments.iter().all(|segment| segment.id < *next))
            .ok_or_else(|| invalid_manifest("has an invalid next segment id"))?;
        out.push(EarlierPartitionEntry {
            partition_id,
            next_segment_id,
            segments,
        });
    }
    Ok(out)
}

fn vector_file_of(raw: &Value, field_path: &str) -> Result<EarlierVectorFileRef> {
    let map = raw.as_object();
    let (Some(map), Some(id), Some(key)) = (
        map,
        map.and_then(|map| id_of(map.get("id"))),
        map.and_then(|map| key_of(map.get("key"))),
    ) else {
        return Err(invalid_manifest("has an invalid vector file reference"));
    };
    let count = uint32_of(map.get("count"))
        .filter(|count| *count as u64 <= VECTOR_FILE_MAX_VECTORS)
        .ok_or_else(|| invalid_manifest(format!("gives \"{field_path}\" an invalid count")))?;
    let dead = match map.get("dead") {
        None | Some(Value::Null) => None,
        Some(Value::Bytes(bytes)) if bytes.len() == dead_bytes_for(count) => Some(bytes.clone()),
        Some(_) => {
            return Err(invalid_manifest(format!(
                "marks the dead vectors of \"{field_path}\" with the wrong number of bytes"
            )));
        }
    };
    Ok(EarlierVectorFileRef {
        id,
        key,
        count,
        dead,
    })
}

fn vectors_of(raw: Option<&Value>) -> Result<Vec<EarlierVectorFieldRef>> {
    let fields = match raw {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(fields)) => fields,
        Some(_) => return Err(invalid_manifest("has malformed vector references")),
    };
    let mut out = Vec::with_capacity(fields.len());
    for field in fields {
        let Some((map, field_path)) = field.as_object().and_then(|map| {
            map.get("fieldPath")
                .and_then(Value::as_str)
                .map(|path| (map, path))
        }) else {
            return Err(invalid_manifest("has an invalid vector reference"));
        };
        let (Some(next_file_id), Some(Value::Array(files)), Some(graph_generation)) = (
            id_of(map.get("nextFileId")),
            map.get("files"),
            id_of(map.get("graphGeneration")),
        ) else {
            return Err(invalid_manifest(format!(
                "gives \"{field_path}\" an invalid vector reference"
            )));
        };
        let graph_key = match map.get("graphKey") {
            None | Some(Value::Null) => None,
            raw => match key_of(raw) {
                Some(key) if graph_generation != 0 => Some(key),
                _ => {
                    return Err(invalid_manifest(format!(
                        "gives \"{field_path}\" an invalid graph key"
                    )));
                }
            },
        };
        out.push(EarlierVectorFieldRef {
            field_path: field_path.to_string(),
            next_file_id,
            files: files
                .iter()
                .map(|file| vector_file_of(file, field_path))
                .collect::<Result<Vec<_>>>()?,
            graph_generation,
            graph_key,
        });
    }
    Ok(out)
}

pub(crate) fn decode_earlier_manifest(raw: &Map) -> Result<EarlierManifest> {
    let Some(Value::Object(schema)) = raw.get("schema") else {
        return Err(invalid_manifest("is missing its schema"));
    };
    require_valid_field_types(schema)?;
    let Some(Value::String(language)) = raw.get("language") else {
        return Err(invalid_manifest("is missing its language"));
    };
    Ok(EarlierManifest {
        schema: schema.clone(),
        language: language.clone(),
        checkpoint: checkpoint_of(raw.get("checkpoint")),
        partitions: partitions_of(raw.get("partitions"))?,
        vectors: vectors_of(raw.get("vectors"))?,
    })
}
