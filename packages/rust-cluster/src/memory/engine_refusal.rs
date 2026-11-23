use narsil::{ErrorCode, Value};

use crate::error::{ClusterError, codes};

const ENGINE_REFUSER: &str = "The engine refuses";
const ENGINE_MEMORY_FULL_REASON: &str = "memory_full";
const NODE_MEMORY_FULL_REASON: &str = "node_memory_full";

pub(crate) fn cluster_refusal_of(error: ClusterError, node_id: &str) -> ClusterError {
    if error.code() != ErrorCode::MEMORY_WRITE_BLOCKED.as_str() {
        return error;
    }
    let message = match error.message().strip_prefix(ENGINE_REFUSER) {
        Some(rest) => format!("Node '{node_id}' refuses{rest}"),
        None => error.message().to_string(),
    };
    let mut refusal = ClusterError::new(codes::CLUSTER_WRITE_BLOCKED, message);
    for (key, value) in error.details().iter() {
        let value = match (key.as_str(), value) {
            ("reason", Value::String(reason)) if reason == ENGINE_MEMORY_FULL_REASON => {
                Value::from(NODE_MEMORY_FULL_REASON)
            }
            _ => value.clone(),
        };
        refusal = refusal.with_detail(key, value);
    }
    if error.details().get("reason").and_then(Value::as_str) == Some(ENGINE_MEMORY_FULL_REASON) {
        refusal = refusal.with_detail("fullNodeIds", Value::Array(vec![Value::from(node_id)]));
    }
    refusal.with_detail("nodeId", Value::from(node_id))
}
