use std::sync::Arc;

use narsil::{Map, Value, encode_msgpack};

use super::Inner;
use crate::error::{ClusterError, codes};
use crate::message::{TransportMessage, message_types, refusal};
use crate::node::decode_request_payload;
use crate::transport::Respond;

const UNSUPPORTED_MESSAGE_TYPES: [&str; 3] = [
    message_types::CLUSTER_REPLICATION_FACTOR,
    message_types::CLUSTER_REBALANCE,
    message_types::SUGGESTIONS_BUILD,
];

const BACKUP_MESSAGE_TYPES: [&str; 3] = [
    message_types::CLUSTER_BACKUP,
    message_types::CLUSTER_BACKUP_RESTORE,
    message_types::CLUSTER_BACKUP_DELETE,
];

const SUPPORTED_MESSAGE_TYPES: [&str; 4] = [
    message_types::REPLICATION_INSYNC_ADD,
    message_types::REPLICATION_INSYNC_REMOVE,
    message_types::REPLICATION_PRIMARY_RESIGN,
    message_types::CLUSTER_BOOTSTRAP_COMPLETE,
];

pub(crate) fn is_controller_message(message_type: &str) -> bool {
    SUPPORTED_MESSAGE_TYPES.contains(&message_type)
        || UNSUPPORTED_MESSAGE_TYPES.contains(&message_type)
        || BACKUP_MESSAGE_TYPES.contains(&message_type)
}

pub(super) fn integer_field(fields: &Map, key: &str) -> Option<f64> {
    match fields.get(key) {
        Some(Value::Number(number)) if number.is_finite() && number.fract() == 0.0 => Some(*number),
        _ => None,
    }
}

pub(super) fn text_field(fields: &Map, key: &str) -> Option<String> {
    match fields.get(key) {
        Some(Value::String(text)) => Some(text.clone()),
        _ => None,
    }
}

pub(super) fn decoded_fields(decoded: &Value) -> Option<&Map> {
    match decoded {
        Value::Object(fields) => Some(fields),
        _ => None,
    }
}

pub(super) fn read_request<T>(
    message: &TransportMessage,
    node_id: &str,
    validate: fn(&Value) -> Option<T>,
    invalid_text: &str,
) -> Result<T, TransportMessage> {
    let decoded = decode_request_payload(&message.payload, &message.message_type)
        .map_err(|error| refusal(message, node_id, &error))?;
    validate(&decoded).ok_or_else(|| {
        refusal(
            message,
            node_id,
            &ClusterError::new(codes::CONFIG_INVALID, invalid_text.to_string()),
        )
    })
}

pub(super) fn missing_member_text(payload_name: &str) -> String {
    format!("Invalid {payload_name}: a member is missing or holds a value of the wrong type")
}

pub(super) fn partition_answer(
    message_type: &str,
    node_id: &str,
    request_id: &str,
    index_name: &str,
    partition_id: f64,
    accepted: bool,
) -> TransportMessage {
    let mut payload = Map::with_capacity(3);
    payload.insert("indexName", Value::String(index_name.to_string()));
    payload.insert("partitionId", Value::Number(partition_id));
    payload.insert("accepted", Value::Bool(accepted));
    let encoded = encode_msgpack(&Value::Object(payload)).unwrap_or_default();
    TransportMessage::new(message_type, node_id, request_id, encoded)
}

fn unsupported(message: &TransportMessage, node_id: &str) -> TransportMessage {
    let error = ClusterError::new(
        codes::CLUSTER_OPERATION_UNSUPPORTED,
        format!(
            "The controller on node '{node_id}' cannot run a {} request, so a controller that can must take the lease",
            message.message_type
        ),
    )
    .with_detail("nodeId", Value::String(node_id.to_string()))
    .with_detail("messageType", Value::String(message.message_type.clone()));
    refusal(message, node_id, &error)
}

pub(super) async fn handle_message(
    inner: &Arc<Inner>,
    message: TransportMessage,
    respond: Respond,
) {
    if BACKUP_MESSAGE_TYPES.contains(&message.message_type.as_str())
        && let Some(answer_backup) = &inner.config.backup_messages
    {
        tokio::spawn(answer_backup(message, respond));
        return;
    }
    if UNSUPPORTED_MESSAGE_TYPES.contains(&message.message_type.as_str())
        || BACKUP_MESSAGE_TYPES.contains(&message.message_type.as_str())
    {
        respond.send(unsupported(&message, inner.node_id())).await;
        return;
    }
    if !inner.is_active() {
        return;
    }
    match message.message_type.as_str() {
        message_types::REPLICATION_INSYNC_REMOVE => {
            inner.handle_insync_remove(message, respond).await
        }
        message_types::REPLICATION_PRIMARY_RESIGN => {
            inner.handle_primary_resign(message, respond).await
        }
        message_types::REPLICATION_INSYNC_ADD => inner.handle_insync_add(message, respond).await,
        message_types::CLUSTER_BOOTSTRAP_COMPLETE => {
            inner.handle_bootstrap_complete(message, respond)
        }
        _ => {}
    }
}
