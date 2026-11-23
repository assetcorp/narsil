use narsil::{Map, Value, encode_msgpack};

use super::state::ReshardStart;
use crate::constants::{MAX_PARTITION_COUNT, MAX_SAFE_INTEGER};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::TransportMessage;
use crate::node::decode_request_payload;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ReshardOperation {
    Replace {
        document_id: String,
        document: Vec<u8>,
    },
    Remove {
        document_id: String,
    },
}

impl ReshardOperation {
    pub(super) fn document_id(&self) -> &str {
        match self {
            ReshardOperation::Replace { document_id, .. }
            | ReshardOperation::Remove { document_id } => document_id,
        }
    }

    fn encoded(&self) -> Value {
        let mut fields = Map::with_capacity(3);
        fields.insert("documentId", Value::from(self.document_id()));
        match self {
            ReshardOperation::Replace { document, .. } => {
                fields.insert("operation", Value::from("replace"));
                fields.insert("document", Value::Bytes(document.clone()));
            }
            ReshardOperation::Remove { .. } => {
                fields.insert("operation", Value::from("remove"));
            }
        }
        Value::Object(fields)
    }
}

pub(super) struct ReshardForward {
    pub(super) target_generation: String,
    pub(super) job_id: String,
    pub(super) source_partition_id: u32,
    pub(super) source_primary_term: u64,
    pub(super) operations: Vec<ReshardOperation>,
}

impl ReshardForward {
    pub(super) fn encoded(&self) -> Value {
        let mut fields = Map::with_capacity(5);
        fields.insert(
            "targetGeneration",
            Value::from(self.target_generation.as_str()),
        );
        fields.insert("jobId", Value::from(self.job_id.as_str()));
        fields.insert("sourcePartitionId", Value::from(self.source_partition_id));
        fields.insert(
            "sourcePrimaryTerm",
            Value::Number(self.source_primary_term as f64),
        );
        fields.insert(
            "operations",
            Value::Array(
                self.operations
                    .iter()
                    .map(ReshardOperation::encoded)
                    .collect(),
            ),
        );
        Value::Object(fields)
    }
}

pub(super) struct ReshardPurge {
    pub(super) target_generation: String,
    pub(super) job_id: String,
    pub(super) source_partition_count: u32,
    pub(super) source_partition_id: u32,
}

impl ReshardPurge {
    pub(super) fn encoded(&self) -> Value {
        let mut fields = Map::with_capacity(4);
        fields.insert(
            "targetGeneration",
            Value::from(self.target_generation.as_str()),
        );
        fields.insert("jobId", Value::from(self.job_id.as_str()));
        fields.insert(
            "sourcePartitionCount",
            Value::from(self.source_partition_count),
        );
        fields.insert("sourcePartitionId", Value::from(self.source_partition_id));
        Value::Object(fields)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CutoverAction {
    Block,
    Lift,
}

pub(super) struct ReshardCutover {
    pub(super) index_name: String,
    pub(super) job_id: String,
    pub(super) partition_id: u32,
    pub(super) action: CutoverAction,
}

fn invalid(what: &str) -> ClusterError {
    ClusterError::new(
        codes::CONFIG_INVALID,
        format!("Invalid partition copy message: {what}"),
    )
}

fn decoded_record(message: &TransportMessage) -> ClusterResult<Map> {
    match decode_request_payload(&message.payload, &message.message_type)? {
        Value::Object(record) => Ok(record),
        _ => Err(invalid("expected an object")),
    }
}

fn text(record: &Map, field: &str) -> ClusterResult<String> {
    match record.get(field) {
        Some(Value::String(value)) if !value.is_empty() => Ok(value.clone()),
        _ => Err(invalid(&format!("\"{field}\" must be a non-empty string"))),
    }
}

fn count(record: &Map, field: &str, minimum: f64, maximum: f64) -> ClusterResult<u64> {
    match record.get(field) {
        Some(Value::Number(value))
            if value.is_finite()
                && value.fract() == 0.0
                && *value >= minimum
                && *value <= maximum =>
        {
            Ok(*value as u64)
        }
        _ => Err(invalid(&format!(
            "\"{field}\" must be an integer from {minimum} to {maximum}"
        ))),
    }
}

fn partition_count(record: &Map, field: &str) -> ClusterResult<u32> {
    Ok(count(record, field, 1.0, MAX_PARTITION_COUNT)? as u32)
}

fn partition_id(record: &Map, field: &str, partitions: f64) -> ClusterResult<u32> {
    Ok(count(record, field, 0.0, partitions - 1.0)? as u32)
}

pub(super) fn read_start(message: &TransportMessage) -> ClusterResult<ReshardStart> {
    let record = decoded_record(message)?;
    let source_partition_count = partition_count(&record, "sourcePartitionCount")?;
    Ok(ReshardStart {
        index_name: text(&record, "indexName")?,
        job_id: text(&record, "jobId")?,
        source_generation: text(&record, "sourceGeneration")?,
        target_generation: text(&record, "targetGeneration")?,
        partition_id: partition_id(&record, "partitionId", f64::from(source_partition_count))?,
        source_partition_count,
        target_partition_count: partition_count(&record, "targetPartitionCount")?,
    })
}

fn read_operation(value: &Value) -> ClusterResult<ReshardOperation> {
    let Value::Object(operation) = value else {
        return Err(invalid("each operation must be an object"));
    };
    let document_id = text(operation, "documentId")?;
    match (operation.get("operation"), operation.get("document")) {
        (Some(Value::String(kind)), _) if kind == "remove" => {
            Ok(ReshardOperation::Remove { document_id })
        }
        (Some(Value::String(kind)), Some(Value::Bytes(document))) if kind == "replace" => {
            Ok(ReshardOperation::Replace {
                document_id,
                document: document.clone(),
            })
        }
        _ => Err(invalid(
            "an operation must be a replace that carries its document, or a remove",
        )),
    }
}

pub(super) fn read_forward(message: &TransportMessage) -> ClusterResult<ReshardForward> {
    let record = decoded_record(message)?;
    let Some(Value::Array(operations)) = record.get("operations") else {
        return Err(invalid("\"operations\" must be a list"));
    };
    Ok(ReshardForward {
        target_generation: text(&record, "targetGeneration")?,
        job_id: text(&record, "jobId")?,
        source_partition_id: partition_id(&record, "sourcePartitionId", MAX_PARTITION_COUNT)?,
        source_primary_term: count(&record, "sourcePrimaryTerm", 0.0, MAX_SAFE_INTEGER as f64)?,
        operations: operations
            .iter()
            .map(read_operation)
            .collect::<ClusterResult<_>>()?,
    })
}

pub(super) fn read_cutover(message: &TransportMessage) -> ClusterResult<ReshardCutover> {
    let record = decoded_record(message)?;
    let action = match record.get("action") {
        Some(Value::String(action)) if action == "block" => CutoverAction::Block,
        Some(Value::String(action)) if action == "lift" => CutoverAction::Lift,
        _ => return Err(invalid("\"action\" must be \"block\" or \"lift\"")),
    };
    Ok(ReshardCutover {
        index_name: text(&record, "indexName")?,
        job_id: text(&record, "jobId")?,
        partition_id: partition_id(&record, "partitionId", MAX_PARTITION_COUNT)?,
        action,
    })
}

pub(super) fn read_purge(message: &TransportMessage) -> ClusterResult<ReshardPurge> {
    let record = decoded_record(message)?;
    let source_partition_count = partition_count(&record, "sourcePartitionCount")?;
    Ok(ReshardPurge {
        target_generation: text(&record, "targetGeneration")?,
        job_id: text(&record, "jobId")?,
        source_partition_count,
        source_partition_id: partition_id(
            &record,
            "sourcePartitionId",
            f64::from(source_partition_count),
        )?,
    })
}

pub(super) fn encoded_answer(fields: Map) -> Vec<u8> {
    encode_msgpack(&Value::Object(fields)).unwrap_or_default()
}
