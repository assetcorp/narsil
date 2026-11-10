use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::fields::{non_negative_safe_integer, uint32_of};
use crate::format::manifest::PartitionCheckpoint;
use crate::schema::require_valid_field_types;
use crate::value::{Map, Value, decode_value, javascript_text};

use super::vector_parts::{EarlierVectorField, decode_vector_field, vector_fields_of};

const SNAPSHOT_BUNDLE_VERSION: f64 = 2.0;

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

fn checkpoint_entry(entry: &Value) -> Option<PartitionCheckpoint> {
    let Value::Object(entry) = entry else {
        return None;
    };
    Some(PartitionCheckpoint {
        partition_id: uint32_of(entry.get("partitionId"))?,
        last_seq_no: non_negative_safe_integer(entry.get("lastSeqNo"))?,
        primary_term: non_negative_safe_integer(entry.get("primaryTerm"))?,
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
                javascript_text(version)
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
    let vector_indexes = vector_fields_of(map.get("vectorIndexes"), decode_vector_field, || {
        invalid("vectorIndexes must be a map")
    })?;
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
