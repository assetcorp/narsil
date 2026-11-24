use narsil::{Map, Value, encode_msgpack};

use crate::constants::{MAX_PARTITION_COUNT, MAX_SAFE_INTEGER};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::TransportMessage;
use crate::node::decode_request_payload;
use crate::payload::term_start::HeldEnd;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum HandoffAction {
    Block,
    Lift,
}

#[derive(Debug, Clone)]
pub(super) struct LeadHandoff {
    pub(super) index_name: String,
    pub(super) partition_id: u32,
    pub(super) primary_term: u64,
    pub(super) target: String,
    pub(super) action: HandoffAction,
}

fn invalid(what: &str) -> ClusterError {
    ClusterError::new(
        codes::CONFIG_INVALID,
        format!("Invalid lead handover message: {what}"),
    )
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

pub(super) fn read_lead_handoff(message: &TransportMessage) -> ClusterResult<LeadHandoff> {
    let Value::Object(record) = decode_request_payload(&message.payload, &message.message_type)?
    else {
        return Err(invalid("expected an object"));
    };
    let action = match record.get("action") {
        Some(Value::String(action)) if action == "block" => HandoffAction::Block,
        Some(Value::String(action)) if action == "lift" => HandoffAction::Lift,
        _ => return Err(invalid("\"action\" must be \"block\" or \"lift\"")),
    };
    Ok(LeadHandoff {
        index_name: text(&record, "indexName")?,
        partition_id: count(&record, "partitionId", 0.0, MAX_PARTITION_COUNT - 1.0)? as u32,
        primary_term: count(&record, "primaryTerm", 1.0, MAX_SAFE_INTEGER as f64)?,
        target: text(&record, "targetNodeId")?,
        action,
    })
}

pub(super) fn encoded_answer(partition_id: u32, end: HeldEnd) -> Vec<u8> {
    let mut answer = Map::with_capacity(3);
    answer.insert("partitionId", Value::from(partition_id));
    answer.insert("lastSeqNo", Value::Number(end.last_seq_no as f64));
    answer.insert(
        "lastPrimaryTerm",
        Value::Number(end.last_primary_term as f64),
    );
    encode_msgpack(&Value::Object(answer)).unwrap_or_default()
}
