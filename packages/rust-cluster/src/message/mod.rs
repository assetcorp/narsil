use bytes::Bytes;
use narsil::{Map, Value, encode_msgpack};

use crate::error::{ClusterError, ClusterResult, codes};
use crate::wire::{self, Reader};
use crate::wire_size;

/// The `type` of the message that a carrier sends in place of an answer where its listener failed or where it
/// could not decode the request.
pub const CARRIER_ERROR_TYPE: &str = "error";

/// The suffix that a node adds to a request's `type` to name its refusal of that request.
pub const ERROR_TYPE_SUFFIX: &str = ".error";

/// The message types of `packages/spec/distribution/transport.md`.
pub mod message_types;

pub(crate) use message_types::is_specified as is_specified_message_type;

/// One message between two cluster nodes, whose payload holds the MessagePack body that its `type` defines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportMessage {
    /// What the message is, such as `cluster.ping`.
    pub message_type: String,
    /// The node id of the sender.
    pub source_id: String,
    /// The id that pairs an answer with its request.
    pub request_id: String,
    /// The encoded body.
    pub payload: Bytes,
}

impl TransportMessage {
    /// Returns a message with the four envelope fields.
    pub fn new(
        message_type: impl Into<String>,
        source_id: impl Into<String>,
        request_id: impl Into<String>,
        payload: impl Into<Bytes>,
    ) -> TransportMessage {
        TransportMessage {
            message_type: message_type.into(),
            source_id: source_id.into(),
            request_id: request_id.into(),
            payload: payload.into(),
        }
    }

    /// Reports whether an answer is a failure: a carrier error, a refusal whose type ends in `.error`, or a payload
    /// that holds `error: true`.
    pub fn is_failure(&self) -> bool {
        if self.message_type == CARRIER_ERROR_TYPE || self.message_type.ends_with(ERROR_TYPE_SUFFIX)
        {
            return true;
        }
        matches!(
            narsil::decode_msgpack(&self.payload),
            Ok(Value::Object(map)) if map.get("error") == Some(&Value::Bool(true))
        )
    }

    /// Returns the failure that an answer carries, reading the code and message of a refusal payload and the
    /// UTF-8 text of a carrier error, or `None` for a successful answer.
    pub fn failure(&self) -> Option<ClusterError> {
        if !self.is_failure() {
            return None;
        }
        if self.message_type == CARRIER_ERROR_TYPE {
            return Some(ClusterError::new(
                codes::TRANSPORT_PEER_UNAVAILABLE,
                String::from_utf8_lossy(&self.payload).into_owned(),
            ));
        }
        let Ok(Value::Object(map)) = narsil::decode_msgpack(&self.payload) else {
            return Some(ClusterError::new(
                codes::TRANSPORT_DECODE_FAILED,
                format!("The {} answer holds no error payload", self.message_type),
            ));
        };
        let text = |key: &str| {
            map.get(key)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        let mut error = ClusterError::new(text("code"), text("message"));
        if let Some(Value::Object(details)) = map.get("details") {
            for (key, value) in details.iter() {
                error = error.with_detail(key, value.clone());
            }
        }
        Some(error)
    }
}

pub(crate) fn encoded_message_len(message: &TransportMessage) -> usize {
    wire_size::FIXMAP_HEADER_BYTES
        + wire_size::str_len("type".len())
        + wire_size::str_len("sourceId".len())
        + wire_size::str_len("requestId".len())
        + wire_size::str_len("payload".len())
        + wire_size::str_len(message.message_type.len())
        + wire_size::str_len(message.source_id.len())
        + wire_size::str_len(message.request_id.len())
        + wire_size::bin_len(message.payload.len())
}

pub(crate) fn encode_message_into(out: &mut Vec<u8>, message: &TransportMessage) {
    wire::write_map_header(out, 4);
    wire::write_str(out, "type");
    wire::write_str(out, &message.message_type);
    wire::write_str(out, "sourceId");
    wire::write_str(out, &message.source_id);
    wire::write_str(out, "requestId");
    wire::write_str(out, &message.request_id);
    wire::write_str(out, "payload");
    wire::write_bin(out, &message.payload);
}

/// Returns the MessagePack encoding of `message`, which both carriers send as the envelope.
pub fn encode_message(message: &TransportMessage) -> Vec<u8> {
    let mut out = Vec::with_capacity(encoded_message_len(message));
    encode_message_into(&mut out, message);
    out
}

fn undecodable(reason: &str) -> ClusterError {
    ClusterError::new(
        codes::TRANSPORT_DECODE_FAILED,
        format!("The transport message cannot be decoded: {reason}"),
    )
}

/// Returns the message that `bytes` holds, slicing the payload out of `bytes` without a copy.
///
/// # Errors
///
/// Fails with `TRANSPORT_DECODE_FAILED` where the bytes are not one MessagePack map that holds a string `type`,
/// `sourceId`, and `requestId` and a binary `payload`.
pub fn decode_message(bytes: &Bytes) -> ClusterResult<TransportMessage> {
    let mut reader = Reader::new(bytes);
    let malformed = |_| undecodable("the envelope is not valid MessagePack");
    let length = reader
        .read_map_length()
        .map_err(|_| undecodable("the envelope is not a map"))?;
    let mut message_type = None;
    let mut source_id = None;
    let mut request_id = None;
    let mut payload = None;
    for _ in 0..length {
        let key = reader
            .read_str()
            .map_err(|_| undecodable("a key is not a string"))?;
        match key {
            "type" => message_type = Some(reader.read_str().map_err(malformed)?.to_string()),
            "sourceId" => source_id = Some(reader.read_str().map_err(malformed)?.to_string()),
            "requestId" => request_id = Some(reader.read_str().map_err(malformed)?.to_string()),
            "payload" => payload = Some(bytes.slice(reader.read_bin().map_err(malformed)?)),
            _ => reader.skip().map_err(malformed)?,
        }
    }
    if !reader.is_finished() {
        return Err(undecodable("bytes follow the envelope"));
    }
    match (message_type, source_id, request_id, payload) {
        (Some(message_type), Some(source_id), Some(request_id), Some(payload)) => {
            Ok(TransportMessage {
                message_type,
                source_id,
                request_id,
                payload,
            })
        }
        _ => Err(undecodable(
            "it needs a string type, sourceId, and requestId and a binary payload",
        )),
    }
}

/// Returns the error payload of a refusal, `{ error: true, code, message }` with `details` where the error holds
/// any.
pub fn encode_error_payload(error: &ClusterError) -> Bytes {
    let mut reply = Map::with_capacity(4);
    reply.insert("error", Value::Bool(true));
    reply.insert("code", Value::String(error.code().to_string()));
    reply.insert("message", Value::String(error.message().to_string()));
    if !error.details().is_empty() {
        let mut with_details = reply.clone();
        with_details.insert("details", Value::Object(error.details().clone()));
        if let Ok(bytes) = encode_msgpack(&Value::Object(with_details)) {
            return Bytes::from(bytes);
        }
    }
    Bytes::from(encode_msgpack(&Value::Object(reply)).unwrap_or_default())
}

/// Returns the refusal of `request` that `node_id` sends, typed as the request's type followed by `.error`.
pub fn refusal(
    request: &TransportMessage,
    node_id: &str,
    error: &ClusterError,
) -> TransportMessage {
    TransportMessage {
        message_type: format!("{}{ERROR_TYPE_SUFFIX}", request.message_type),
        source_id: node_id.to_string(),
        request_id: request.request_id.clone(),
        payload: encode_error_payload(error),
    }
}

pub(crate) fn carrier_error(request_id: &str, text: &str) -> TransportMessage {
    TransportMessage {
        message_type: CARRIER_ERROR_TYPE.to_string(),
        source_id: String::new(),
        request_id: request_id.to_string(),
        payload: Bytes::copy_from_slice(text.as_bytes()),
    }
}
