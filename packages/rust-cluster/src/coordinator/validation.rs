use narsil::Value;

use crate::constants::MAX_NODE_ID_LENGTH;
use crate::error::{ClusterError, ClusterResult, codes};

/// Checks that `node_id` is safe to use inside an etcd key, which the coordinator also checks on every registration.
///
/// The coordinator builds each key from the node id, so an id that holds a separator or a traversal sequence would
/// reach another node's keys. The length counts UTF-16 code units, as TypeScript counts it.
///
/// # Errors
///
/// Fails with `CONFIG_INVALID` where the id is empty, longer than 255 code units, or holds `/`, `\`, `..`, or a null
/// byte.
pub fn validate_node_id(node_id: &str) -> ClusterResult<()> {
    if node_id.is_empty() {
        return Err(ClusterError::new(
            codes::CONFIG_INVALID,
            "Node ID must not be empty",
        ));
    }
    let length = node_id.encode_utf16().count();
    if length > MAX_NODE_ID_LENGTH {
        return Err(ClusterError::new(
            codes::CONFIG_INVALID,
            format!("Node ID exceeds the {MAX_NODE_ID_LENGTH} character limit"),
        )
        .with_detail("nodeId", Value::String(node_id.to_string()))
        .with_detail("length", Value::Number(length as f64)));
    }
    if node_id.contains('/')
        || node_id.contains('\\')
        || node_id.contains("..")
        || node_id.contains('\0')
    {
        return Err(ClusterError::new(
            codes::CONFIG_INVALID,
            "Node ID contains forbidden characters (/, \\, .., or null bytes)",
        )
        .with_detail("nodeId", Value::String(node_id.to_string())));
    }
    Ok(())
}

pub(crate) fn is_valid_node_id(node_id: &str) -> bool {
    validate_node_id(node_id).is_ok()
}
