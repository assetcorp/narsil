use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::graph_part::GraphParts;
use crate::format::vector_file::{VectorCodes, osq_record_bytes, require_payload_version};
use crate::util::bytes::f32_list;
use crate::value::{Map, Value};

use super::graph::earlier_graph_parts;

pub(crate) const VECTOR_INDEX_PAYLOAD_VERSION: u8 = 3;
pub(crate) const VECTOR_INDEX_PART_VECTORS: usize = 65_536;
pub(super) const PREFIX: &str = "Invalid vector index payload: ";
const FLOAT32_BYTES: u128 = 4;
static UNVERSIONED_LAYOUT: Value = Value::Number(1.0);

/// One part of a vector field that engine 0.3.0 wrote into a snapshot: the IDs of its documents, one float32
/// vector for each, and the quantised codes when the field kept them.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct EarlierVectorPart {
    pub(crate) field_name: String,
    pub(crate) dimension: usize,
    pub(crate) part: u64,
    pub(crate) parts: u64,
    pub(crate) doc_ids: Vec<String>,
    pub(crate) vectors: Vec<f32>,
    pub(crate) codes: Option<VectorCodes>,
}

/// Every part of one vector field of an earlier snapshot, with its HNSW graphs numbered by the position of each
/// vector across the parts in order.
///
/// `graph` holds the first graph that has a node, then one graph that holds a node of top layer 0 for every
/// vector that a later graph holds, because a restore keeps the first graph whole and places the nodes of the
/// later graphs again. It is `None` when no graph has a node, or when the first such graph names no supported
/// metric, so that a restore builds the graph from the vectors.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct EarlierVectorField {
    pub(crate) parts: Vec<EarlierVectorPart>,
    pub(crate) graph: Option<GraphParts>,
}

pub(super) fn invalid(message: impl AsRef<str>) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_LOAD_FAILED,
        format!("{PREFIX}{}", message.as_ref()),
    )
}

fn non_negative_integer(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) if number.fract() == 0.0 && *number >= 0.0 => Some(*number),
        _ => None,
    }
}

fn is_graph(value: &Value) -> bool {
    matches!(value, Value::Object(map) if matches!(map.get("nodes"), Some(Value::Array(_))))
}

fn decode_codes(
    raw: Option<&Value>,
    dimension: usize,
    count: usize,
) -> Result<Option<VectorCodes>> {
    let codes = match raw {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Object(codes)) => codes,
        Some(_) => return Err(invalid("codes must be a map or nil")),
    };
    let bits = match codes.get("bits") {
        Some(Value::Number(number)) if [1.0, 2.0, 4.0, 8.0].contains(number) => *number as u8,
        _ => return Err(invalid("codes.bits must be 8, 4, 2, or 1")),
    };
    let centroid = match codes.get("centroid") {
        Some(Value::Array(items)) if items.len() == dimension => items
            .iter()
            .map(|item| {
                item.as_f64()
                    .ok_or_else(|| invalid("codes.centroid must hold one number per dimension"))
            })
            .collect::<Result<Vec<f64>>>()?,
        _ => return Err(invalid("codes.centroid must hold one number per dimension")),
    };
    let records = match codes.get("records") {
        Some(Value::Bytes(bytes)) => bytes.clone(),
        _ => return Err(invalid("codes.records must be bytes")),
    };
    let expected = dimension
        .checked_mul(usize::from(bits))
        .and_then(|_| count.checked_mul(osq_record_bytes(dimension, bits)));
    if expected != Some(records.len()) {
        return Err(invalid("codes.records must hold one record per vector"));
    }
    Ok(Some(VectorCodes {
        bits,
        centroid,
        records,
    }))
}

fn doc_ids_of(map: &Map) -> Result<Vec<String>> {
    let Some(Value::Array(items)) = map.get("docIds") else {
        return Err(invalid("docIds must be a list of strings"));
    };
    items
        .iter()
        .map(|item| match item {
            Value::String(text) => Ok(text.clone()),
            _ => Err(invalid("docIds must be a list of strings")),
        })
        .collect()
}

fn decode_part(raw: &Value) -> Result<(EarlierVectorPart, &[Value])> {
    let Value::Object(map) = raw else {
        return Err(invalid("payload must be a map"));
    };
    let version = match map.get("v") {
        None | Some(Value::Null) => Some(&UNVERSIONED_LAYOUT),
        found => found,
    };
    require_payload_version("vector index", version, VECTOR_INDEX_PAYLOAD_VERSION)?;
    let Some(Value::String(field_name)) = map.get("fieldName") else {
        return Err(invalid("fieldName must be a string"));
    };
    let dimension = match non_negative_integer(map.get("dimension")) {
        Some(number) if number > 0.0 => usize::try_from(number as u64)
            .map_err(|_| invalid("dimension must be a positive integer"))?,
        _ => return Err(invalid("dimension must be a positive integer")),
    };
    let Some(part) = non_negative_integer(map.get("part")) else {
        return Err(invalid("part must be a non-negative integer"));
    };
    let parts = match non_negative_integer(map.get("parts")) {
        Some(parts) if parts > 0.0 && part < parts => parts,
        _ => return Err(invalid("parts must exceed part")),
    };
    let doc_ids = doc_ids_of(map)?;
    if doc_ids.len() > VECTOR_INDEX_PART_VECTORS {
        return Err(invalid(format!(
            "a part holds at most {VECTOR_INDEX_PART_VECTORS} vectors"
        )));
    }
    let graphs = match map.get("graphs") {
        Some(Value::Array(graphs)) if graphs.iter().all(is_graph) => graphs.as_slice(),
        _ => {
            return Err(invalid(
                "graphs must be a list of graphs, each holding a list of nodes",
            ));
        }
    };
    let Some(Value::Bytes(vector_bytes)) = map.get("vectors") else {
        return Err(invalid("vectors must be bytes"));
    };
    let expected = doc_ids.len() as u128 * dimension as u128 * FLOAT32_BYTES;
    if vector_bytes.len() as u128 != expected {
        return Err(invalid(
            "vectors must hold dimension float32 components per document",
        ));
    }
    let codes = decode_codes(map.get("codes"), dimension, doc_ids.len())?;
    let vectors = f32_list(vector_bytes, "vectors")?;
    Ok((
        EarlierVectorPart {
            field_name: field_name.clone(),
            dimension,
            part: part as u64,
            parts: parts as u64,
            doc_ids,
            vectors,
            codes,
        },
        graphs,
    ))
}

fn decoded_parts(raw: &Value) -> Result<Vec<(EarlierVectorPart, &[Value])>> {
    let Value::Array(parts) = raw else {
        return Err(invalid("a field must carry a list of parts"));
    };
    parts.iter().map(decode_part).collect()
}

/// Reads the list of vector index parts that engine 0.3.0 wrote for one field of a snapshot, with the checks
/// of the reference reader in its order, and leaves their graphs out.
pub(crate) fn decode_vector_parts(raw: &Value) -> Result<Vec<EarlierVectorPart>> {
    Ok(decoded_parts(raw)?
        .into_iter()
        .map(|(part, _)| part)
        .collect())
}

/// Reads the list of vector index parts that engine 0.3.0 wrote for one field of a snapshot bundle, and numbers
/// its HNSW graphs for a restore.
///
/// It raises `PERSISTENCE_LOAD_FAILED` for a malformed part, for a graph with a node whose `m` is not a whole
/// number from 2 to 512, and for a graph with more upper-layer lists than the specification allows, and
/// `ENVELOPE_VERSION_MISMATCH` for a part of a layout other than 3.
pub(crate) fn decode_vector_field(raw: &Value) -> Result<EarlierVectorField> {
    let decoded = decoded_parts(raw)?;
    let graph = earlier_graph_parts(&decoded)?;
    Ok(EarlierVectorField {
        parts: decoded.into_iter().map(|(part, _)| part).collect(),
        graph,
    })
}
