use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::manifest::PartitionCheckpoint;
use crate::schema::require_valid_field_types;
use crate::value::{Map, Value, decode_value};

use super::shown_as_text;
use super::vector_parts::{EarlierVectorField, decode_vector_field};

const SNAPSHOT_BUNDLE_VERSION: f64 = 2.0;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// The snapshot bundle that engine 0.3.0 saved under `<indexName>/snapshot` on the snapshot-only tier.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SnapshotBundle {
    /// The flat schema of the index.
    pub(crate) schema: Map,
    /// The name of the index's language.
    pub(crate) language: String,
    /// One version 2 partition payload for each partition, in partition order, for
    /// [`decode_v2_documents`](super::decode_v2_documents) to read.
    pub(crate) partitions: Vec<Vec<u8>>,
    /// Each vector field path with its parts and graphs, in the order that the reference reader walks them.
    pub(crate) vector_indexes: Vec<(String, EarlierVectorField)>,
    /// The log position that the bundle covers for each partition.
    pub(crate) checkpoint: Vec<PartitionCheckpoint>,
}

fn invalid(message: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_LOAD_FAILED,
        format!("Snapshot bundle {message}"),
    )
}

fn whole_number_up_to(value: Option<&Value>, highest: f64) -> Option<f64> {
    match value {
        Some(Value::Number(number))
            if number.fract() == 0.0 && (0.0..=highest).contains(number) =>
        {
            Some(*number)
        }
        _ => None,
    }
}

fn checkpoint_entry(entry: &Value) -> Option<PartitionCheckpoint> {
    let Value::Object(entry) = entry else {
        return None;
    };
    let partition_id = whole_number_up_to(entry.get("partitionId"), f64::from(u32::MAX))?;
    let last_seq_no = whole_number_up_to(entry.get("lastSeqNo"), MAX_SAFE_INTEGER)?;
    let primary_term = whole_number_up_to(entry.get("primaryTerm"), MAX_SAFE_INTEGER)?;
    Some(PartitionCheckpoint {
        partition_id: partition_id as u32,
        last_seq_no: last_seq_no as u64,
        primary_term: primary_term as u64,
        term_history: None,
    })
}

fn partitions_of(raw: Option<Value>) -> Result<Vec<Vec<u8>>> {
    let Some(Value::Array(items)) = raw else {
        return Err(invalid("missing partitions"));
    };
    items
        .into_iter()
        .map(|item| match item {
            Value::Bytes(bytes) => Ok(bytes),
            _ => Err(invalid("missing partitions")),
        })
        .collect()
}

fn vector_indexes_of(raw: Option<&Value>) -> Result<Vec<(String, EarlierVectorField)>> {
    match raw {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Object(fields)) => fields
            .iter()
            .map(|(path, parts)| Ok((path.clone(), decode_vector_field(parts)?)))
            .collect(),
        Some(_) => Err(invalid("vectorIndexes must be a map")),
    }
}

/// Reads the payload of a snapshot bundle that engine 0.3.0 wrote, after the caller has opened its envelope,
/// with the checks of the reference reader in its order.
///
/// It raises `ENVELOPE_VERSION_MISMATCH` for a bundle of a layout other than 2, `SCHEMA_INVALID_TYPE` for a
/// schema that names an unknown type, and `PERSISTENCE_LOAD_FAILED` for a bundle without a schema, a language,
/// or a list of partition payloads, and for a malformed vector field. It leaves out each checkpoint entry that
/// lacks a whole partition ID, log position, or primary term, as the reference reader does.
pub(crate) fn decode_snapshot_bundle(payload: &[u8]) -> Result<SnapshotBundle> {
    let mut map = match decode_value(payload)? {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    let version = map.get("version");
    if !matches!(version, Some(Value::Number(number)) if *number == SNAPSHOT_BUNDLE_VERSION) {
        return Err(NarsilError::new(
            ErrorCode::ENVELOPE_VERSION_MISMATCH,
            format!(
                "The snapshot bundle holds layout {}, which this release cannot open. Export the index with the release that wrote it and import the export",
                shown_as_text(version)
            ),
        ));
    }
    let Some(Value::Object(schema)) = map.remove("schema") else {
        return Err(invalid("missing schema"));
    };
    require_valid_field_types(&schema)?;
    let Some(Value::String(language)) = map.remove("language") else {
        return Err(invalid("missing language"));
    };
    let partitions = partitions_of(map.remove("partitions"))?;
    let vector_indexes = vector_indexes_of(map.get("vectorIndexes"))?;
    let checkpoint = match map.get("checkpoint") {
        Some(Value::Array(entries)) => entries.iter().filter_map(checkpoint_entry).collect(),
        _ => Vec::new(),
    };
    Ok(SnapshotBundle {
        schema,
        language,
        partitions,
        vector_indexes,
        checkpoint,
    })
}
