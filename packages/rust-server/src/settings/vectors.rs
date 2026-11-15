use narsil::{ErrorCode, Narsil, Value, VectorMaintenanceStatus};

use super::errors::after_engine_checks;
use crate::errors::{Outcome, ServerError};
use crate::handlers::common::object;
use crate::script_values::{script_text, script_truthy};

pub(crate) enum CompactTarget {
    Every,
    Field(String),
    Unnamable(Value),
    Unreadable,
}

pub(crate) fn compact_target_of(body: &Value) -> CompactTarget {
    if !script_truthy(body) {
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
        ErrorCode::INDEX_NOT_FOUND.as_str(),
        format!("Vector field \"{shown}\" not found in index \"{index_name}\""),
    )
    .with_detail("indexName", Value::String(index_name.to_string()))
    .with_detail("fieldName", field)
}

pub(crate) fn compact(engine: &Narsil, index_name: &str, target: CompactTarget) -> Outcome<()> {
    match target {
        CompactTarget::Every => engine
            .compact_vectors(index_name, None)
            .map_err(ServerError::from),
        CompactTarget::Field(field) => engine
            .compact_vectors(index_name, Some(&field))
            .map_err(ServerError::from),
        CompactTarget::Unnamable(field) => {
            let failure = field_not_found(index_name, &script_text(&field), field);
            Err(after_engine_checks(
                engine,
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
