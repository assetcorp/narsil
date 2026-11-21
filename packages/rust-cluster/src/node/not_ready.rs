use std::time::{SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use narsil::{Value, decode_msgpack};

use crate::error::{ClusterError, codes};
use crate::message::{TransportMessage, message_types, refusal};
use crate::transport::{ListenHandler, Respond, listen_handler};
use crate::wire;

pub(crate) fn decode_request_payload(
    payload: &[u8],
    message_type: &str,
) -> Result<Value, ClusterError> {
    decode_msgpack(payload).map_err(|error| {
        ClusterError::new(
            codes::TRANSPORT_DECODE_FAILED,
            format!("The payload of a {message_type} request is not valid MessagePack"),
        )
        .with_detail("messageType", Value::String(message_type.to_string()))
        .with_detail("cause", Value::String(error.message().to_string()))
    })
}

fn ping_timestamp(payload: &[u8]) -> Result<f64, ClusterError> {
    let decoded = decode_request_payload(payload, message_types::CLUSTER_PING)?;
    let timestamp = match &decoded {
        Value::Object(fields) => fields.get("timestamp"),
        _ => None,
    };
    match timestamp {
        Some(Value::Number(number))
            if number.is_finite() && number.fract() == 0.0 && *number >= 0.0 =>
        {
            Ok(*number)
        }
        _ => Err(ClusterError::new(
            codes::CONFIG_INVALID,
            "Invalid PingPayload: it needs a timestamp that is a non-negative integer",
        )),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

fn pong_payload(timestamp: f64, responded_at: u64) -> Bytes {
    let mut out = Vec::with_capacity(32);
    wire::write_map_header(&mut out, 2);
    wire::write_str(&mut out, "timestamp");
    wire::write_number(&mut out, timestamp);
    wire::write_str(&mut out, "respondedAt");
    wire::write_uint(&mut out, responded_at);
    Bytes::from(out)
}

pub(crate) fn answer_ping(message: &TransportMessage, node_id: &str) -> TransportMessage {
    match ping_timestamp(&message.payload) {
        Ok(timestamp) => TransportMessage {
            message_type: message_types::CLUSTER_PONG.to_string(),
            source_id: node_id.to_string(),
            request_id: message.request_id.clone(),
            payload: pong_payload(timestamp, now_ms()),
        },
        Err(error) => refusal(message, node_id, &error),
    }
}

pub(crate) fn not_ready(node_id: &str) -> ClusterError {
    ClusterError::new(
        codes::NODE_NOT_READY,
        format!("Node '{node_id}' has yet to finish joining the cluster, so it serves nothing"),
    )
    .with_detail("nodeId", Value::String(node_id.to_string()))
}

/// Returns the handler that a node listens with before it joins the cluster, which answers a `cluster.ping` with a
/// `cluster.pong` and refuses every other message with `NODE_NOT_READY`.
///
/// A node opens its listener before it registers, so that a peer reaching it early receives a stated refusal in
/// place of a connection failure that the peer would have to time out on.
pub fn not_ready_handler(node_id: impl Into<String>) -> ListenHandler {
    let node_id: String = node_id.into();
    listen_handler(move |message: TransportMessage, respond: Respond| {
        let reply = if message.message_type == message_types::CLUSTER_PING {
            answer_ping(&message, &node_id)
        } else {
            refusal(&message, &node_id, &not_ready(&node_id))
        };
        async move {
            respond.send(reply).await;
            Ok(())
        }
    })
}
