use narsil::{Map, Value, encode_msgpack};

use super::copies::StoredPartitions;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::TransportMessage;
use crate::node::decode_request_payload;

const INVALID_PARTITION_STORES: &str =
    "Invalid PartitionStoresPayload: it needs an indexName that is a non-empty string";

pub(super) fn requested_index(message: &TransportMessage) -> ClusterResult<String> {
    let decoded = decode_request_payload(&message.payload, &message.message_type)?;
    match &decoded {
        Value::Object(fields) => match fields.get("indexName") {
            Some(Value::String(index_name)) if !index_name.is_empty() => Ok(index_name.clone()),
            _ => Err(ClusterError::new(
                codes::CONFIG_INVALID,
                INVALID_PARTITION_STORES,
            )),
        },
        _ => Err(ClusterError::new(
            codes::CONFIG_INVALID,
            INVALID_PARTITION_STORES,
        )),
    }
}

pub(super) fn partition_stores_answer(
    message: &TransportMessage,
    node_id: &str,
    index_name: &str,
    stored: StoredPartitions,
) -> ClusterResult<TransportMessage> {
    let mut payload = Map::with_capacity(3);
    payload.insert("indexName", Value::String(index_name.to_string()));
    payload.insert(
        "indexUuid",
        stored.index_uuid.map_or(Value::Null, Value::String),
    );
    payload.insert(
        "partitionIds",
        Value::Array(stored.partition_ids.into_iter().map(Value::from).collect()),
    );
    Ok(TransportMessage::new(
        message.message_type.as_str(),
        node_id,
        message.request_id.as_str(),
        encode_msgpack(&Value::Object(payload))?,
    ))
}
