use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::envelope::{HEADER_BYTES, MAX_FILE_BYTES};
use crate::format::layout::{graph_part_key, vector_file_key};
use crate::value::{Map, Value};

pub(crate) const MAX_SEGMENT_ID: f64 = 281_474_976_710_655.0;
pub(crate) const VECTOR_FILE_MAX_VECTORS: u64 = 65_536;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Head {
    pub(crate) offset: u64,
    pub(crate) length: u32,
    pub(crate) checksum: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileRef {
    pub(crate) key: String,
    pub(crate) bytes: u64,
    pub(crate) checksum: u32,
    pub(crate) head: Option<Head>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VectorFileRef {
    pub(crate) id: u64,
    pub(crate) file: FileRef,
    pub(crate) count: u32,
    pub(crate) dead: Option<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VectorFieldRef {
    pub(crate) field_path: String,
    pub(crate) next_file_id: u64,
    pub(crate) files: Vec<VectorFileRef>,
    pub(crate) graph_generation: u64,
    pub(crate) graph_parts: Vec<FileRef>,
}

pub(crate) fn invalid_manifest(message: impl AsRef<str>) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_LOAD_FAILED,
        format!("Segment manifest {}", message.as_ref()),
    )
}

fn integer(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) if number.is_finite() && number.fract() == 0.0 => Some(*number),
        _ => None,
    }
}

pub(crate) fn id_of(value: Option<&Value>) -> Option<u64> {
    integer(value)
        .filter(|number| *number >= 0.0 && *number <= MAX_SEGMENT_ID)
        .map(|number| number as u64)
}

pub(crate) fn uint32_of(value: Option<&Value>) -> Option<u32> {
    integer(value)
        .filter(|number| *number >= 0.0 && *number <= u32::MAX as f64)
        .map(|number| number as u32)
}

pub(crate) fn sequence_of(value: Option<&Value>) -> Option<u64> {
    integer(value)
        .filter(|number| *number >= 0.0 && *number <= MAX_SAFE_INTEGER)
        .map(|number| number as u64)
}

pub(crate) fn read_file_ref(raw: &Map, expected_key: &str, what: &str) -> Result<FileRef> {
    if raw.get("key").and_then(Value::as_str) != Some(expected_key) {
        let shown = match raw.get("key") {
            Some(Value::String(key)) => key.clone(),
            None => "undefined".to_string(),
            Some(other) => other.to_json(),
        };
        return Err(invalid_manifest(format!(
            "lists the {what} under the key \"{shown}\" where it belongs at \"{expected_key}\""
        )));
    }
    let bytes = integer(raw.get("bytes"))
        .filter(|bytes| *bytes >= HEADER_BYTES as f64 && *bytes <= MAX_FILE_BYTES as f64)
        .ok_or_else(|| {
            invalid_manifest(format!(
                "gives the {what} \"{expected_key}\" an invalid length"
            ))
        })? as u64;
    let checksum = uint32_of(raw.get("checksum")).ok_or_else(|| {
        invalid_manifest(format!(
            "gives the {what} \"{expected_key}\" an invalid checksum"
        ))
    })?;
    if !raw.contains_key("headOffset") {
        return Ok(FileRef {
            key: expected_key.to_string(),
            bytes,
            checksum,
            head: None,
        });
    }
    let (Some(offset), Some(length), Some(head_checksum)) = (
        sequence_of(raw.get("headOffset")),
        uint32_of(raw.get("headLength")),
        uint32_of(raw.get("headChecksum")),
    ) else {
        return Err(invalid_manifest(format!(
            "gives the {what} \"{expected_key}\" an invalid head"
        )));
    };
    if offset + length as u64 > bytes - HEADER_BYTES as u64 {
        return Err(invalid_manifest(format!(
            "ends the head of the {what} \"{expected_key}\" outside its payload"
        )));
    }
    Ok(FileRef {
        key: expected_key.to_string(),
        bytes,
        checksum,
        head: Some(Head {
            offset,
            length,
            checksum: head_checksum,
        }),
    })
}

pub(crate) fn file_ref_to_wire(map: &mut Map, file: &FileRef) {
    map.insert("key", Value::String(file.key.clone()));
    map.insert("bytes", Value::Number(file.bytes as f64));
    map.insert("checksum", Value::Number(file.checksum as f64));
    if let Some(head) = &file.head {
        map.insert("headOffset", Value::Number(head.offset as f64));
        map.insert("headLength", Value::Number(head.length as f64));
        map.insert("headChecksum", Value::Number(head.checksum as f64));
    }
}

fn record(value: &Value) -> Option<&Map> {
    value.as_object()
}

pub(crate) fn dead_bytes_for(count: u32) -> usize {
    (count as usize).div_ceil(8)
}

fn normalize_file(
    raw: &Value,
    index_name: &str,
    field_path: &str,
    next_file_id: u64,
    seen: &mut Vec<u64>,
) -> Result<VectorFileRef> {
    let map =
        record(raw).ok_or_else(|| invalid_manifest("has an invalid vector file reference"))?;
    let id = id_of(map.get("id"))
        .ok_or_else(|| invalid_manifest("has an invalid vector file reference"))?;
    if id >= next_file_id || seen.contains(&id) {
        return Err(invalid_manifest(format!(
            "lists vector file {id} of \"{field_path}\" twice or at its next file id"
        )));
    }
    seen.push(id);
    let count = integer(map.get("count"))
        .filter(|count| *count >= 0.0 && *count <= VECTOR_FILE_MAX_VECTORS as f64)
        .ok_or_else(|| {
            invalid_manifest(format!(
                "gives vector file {id} of \"{field_path}\" an invalid count"
            ))
        })? as u32;
    let dead = match map.get("dead") {
        None | Some(Value::Null) => None,
        Some(Value::Bytes(bytes)) => Some(bytes.clone()),
        Some(_) => return Err(invalid_manifest("has dead vectors that are not bytes")),
    };
    if dead
        .as_ref()
        .is_some_and(|dead| dead.len() != dead_bytes_for(count))
    {
        return Err(invalid_manifest(format!(
            "marks the dead vectors of file {id} of \"{field_path}\" with the wrong number of bytes"
        )));
    }
    let key = vector_file_key(index_name, field_path, id)
        .map_err(|error| invalid_manifest(error.message()))?;
    let file = read_file_ref(map, &key, "vector file")?;
    Ok(VectorFileRef {
        id,
        file,
        count,
        dead,
    })
}

fn normalize_graph_parts(
    raw: Option<&Value>,
    index_name: &str,
    field_path: &str,
    generation: u64,
) -> Result<Vec<FileRef>> {
    let Some(Value::Array(parts)) = raw else {
        return Err(invalid_manifest(format!(
            "gives \"{field_path}\" no list of graph parts"
        )));
    };
    if !parts.is_empty() && generation == 0 {
        return Err(invalid_manifest(format!(
            "lists graph parts of \"{field_path}\" at generation 0"
        )));
    }
    let mut out = Vec::with_capacity(parts.len());
    for (at, part) in parts.iter().enumerate() {
        let map = record(part).ok_or_else(|| {
            invalid_manifest(format!("has an invalid graph part of \"{field_path}\""))
        })?;
        let key = graph_part_key(index_name, field_path, generation, at as u64)
            .map_err(|error| invalid_manifest(error.message()))?;
        out.push(read_file_ref(map, &key, "graph part")?);
    }
    Ok(out)
}

pub(crate) fn normalize_vector_fields(
    raw: Option<&Value>,
    index_name: &str,
) -> Result<Vec<VectorFieldRef>> {
    let Some(Value::Array(fields)) = raw else {
        return Err(invalid_manifest("has malformed vector references"));
    };
    let mut seen_fields: Vec<&str> = Vec::new();
    let mut out = Vec::with_capacity(fields.len());
    for field in fields {
        let map =
            record(field).ok_or_else(|| invalid_manifest("has an invalid vector reference"))?;
        let field_path = map
            .get("fieldPath")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid_manifest("has an invalid vector reference"))?;
        if seen_fields.contains(&field_path) {
            return Err(invalid_manifest(format!(
                "lists the vector field \"{field_path}\" twice"
            )));
        }
        seen_fields.push(field_path);
        let next_file_id = id_of(map.get("nextFileId")).ok_or_else(|| {
            invalid_manifest(format!("gives \"{field_path}\" an invalid next file id"))
        })?;
        let Some(Value::Array(files)) = map.get("files") else {
            return Err(invalid_manifest(format!(
                "gives \"{field_path}\" no list of vector files"
            )));
        };
        let graph_generation = id_of(map.get("graphGeneration")).ok_or_else(|| {
            invalid_manifest(format!(
                "gives \"{field_path}\" an invalid graph generation"
            ))
        })?;
        let mut seen_ids = Vec::new();
        let files = files
            .iter()
            .map(|file| normalize_file(file, index_name, field_path, next_file_id, &mut seen_ids))
            .collect::<Result<Vec<_>>>()?;
        let graph_parts = normalize_graph_parts(
            map.get("graphParts"),
            index_name,
            field_path,
            graph_generation,
        )?;
        out.push(VectorFieldRef {
            field_path: field_path.to_string(),
            next_file_id,
            files,
            graph_generation,
            graph_parts,
        });
    }
    Ok(out)
}

pub(crate) fn vector_fields_to_wire(fields: &[VectorFieldRef]) -> Value {
    let wire = fields
        .iter()
        .map(|field| {
            let mut map = Map::new();
            map.insert("fieldPath", Value::String(field.field_path.clone()));
            map.insert("nextFileId", Value::Number(field.next_file_id as f64));
            let files = field
                .files
                .iter()
                .map(|file| {
                    let mut entry = Map::new();
                    entry.insert("id", Value::Number(file.id as f64));
                    file_ref_to_wire(&mut entry, &file.file);
                    entry.insert("count", Value::Number(file.count as f64));
                    entry.insert("dead", file.dead.clone().map_or(Value::Null, Value::Bytes));
                    Value::Object(entry)
                })
                .collect();
            map.insert("files", Value::Array(files));
            map.insert(
                "graphGeneration",
                Value::Number(field.graph_generation as f64),
            );
            let parts = field
                .graph_parts
                .iter()
                .map(|part| {
                    let mut entry = Map::new();
                    file_ref_to_wire(&mut entry, part);
                    Value::Object(entry)
                })
                .collect();
            map.insert("graphParts", Value::Array(parts));
            Value::Object(map)
        })
        .collect();
    Value::Array(wire)
}
