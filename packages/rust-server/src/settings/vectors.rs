use narsil::{Narsil, Value, VectorMaintenanceStatus};

use super::errors::{after_engine_checks, indexed};
use super::js_text::{is_falsy, string_of};
use crate::errors::{Outcome, ServerError};
use crate::handlers::common::object;

const INDEX_NOT_FOUND: &str = "INDEX_NOT_FOUND";

pub(crate) enum CompactTarget {
    Every,
    Field(String),
    Unnamable(Value),
    Unreadable,
}

pub(crate) fn compact_target_of(body: &Value) -> CompactTarget {
    if is_falsy(body) {
        return CompactTarget::Unreadable;
    }
    let Value::Object(fields) = body else {
        return CompactTarget::Every;
    };
    match fields.get("field") {
        None => CompactTarget::Every,
        Some(Value::String(field)) => CompactTarget::Field(field.clone()),
        Some(other) => CompactTarget::Unnamable(other.clone()),
    }
}

fn field_not_found(index_name: &str, shown: &str, field: Value) -> ServerError {
    ServerError::coded(
        INDEX_NOT_FOUND,
        format!("Vector field \"{shown}\" not found in index \"{index_name}\""),
    )
    .with_detail("indexName", Value::String(index_name.to_string()))
    .with_detail("fieldName", field)
}

fn with_field_details(failure: ServerError, index_name: &str, field: &str) -> ServerError {
    let missing = format!("Vector field \"{field}\" not found in index \"{index_name}\"");
    if failure.code == INDEX_NOT_FOUND && failure.message == missing && failure.details.is_none() {
        return field_not_found(index_name, field, Value::String(field.to_string()));
    }
    indexed(failure, index_name)
}

pub(crate) fn compact(engine: &Narsil, index_name: &str, target: CompactTarget) -> Outcome<()> {
    match target {
        CompactTarget::Every => engine
            .compact_vectors(index_name, None)
            .map_err(|raised| indexed(ServerError::from(raised), index_name)),
        CompactTarget::Field(field) => engine
            .compact_vectors(index_name, Some(&field))
            .map_err(|raised| with_field_details(ServerError::from(raised), index_name, &field)),
        CompactTarget::Unnamable(field) => {
            let failure = field_not_found(index_name, &string_of(&field), field);
            Err(after_engine_checks(
                engine,
                index_name,
                failure,
                |engine| engine.vector_maintenance_status(index_name),
                |_| false,
            ))
        }
        CompactTarget::Unreadable => Err(ServerError::invalid(
            "Send the vector field to compact as { \"field\": \"name\" }, or send no body to compact every vector field",
        )),
    }
}

fn status_json(status: &VectorMaintenanceStatus) -> Value {
    object(vec![
        ("fieldName", Value::String(status.field_name.clone())),
        ("tombstoneRatio", Value::Number(status.tombstone_ratio)),
        ("graphCount", Value::Number(f64::from(status.graph_count))),
        ("bufferSize", Value::Number(status.buffer_size as f64)),
        ("building", Value::Bool(status.building)),
        ("waitingForMemory", Value::Bool(status.waiting_for_memory)),
        ("loadingFromFiles", Value::Bool(status.loading_from_files)),
        (
            "estimatedCompactMs",
            Value::Number(status.estimated_compact_ms as f64),
        ),
        (
            "estimatedOptimizeMs",
            Value::Number(status.estimated_optimize_ms as f64),
        ),
    ])
}

pub(crate) fn maintenance_json(statuses: &[VectorMaintenanceStatus]) -> Value {
    object(vec![(
        "fields",
        Value::Array(statuses.iter().map(status_json).collect()),
    )])
}
