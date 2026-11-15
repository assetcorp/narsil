use narsil::{Map, Value, decode_msgpack, encode_msgpack};

use super::constants::MAX_CLOSE_REASON_BYTES;
use crate::constants::MAX_SAFE_INTEGER;
use crate::script_values::whole_number;

pub(crate) const SYNC_SUBPROTOCOL: &str = "narsil.sync.v1";
pub(crate) const CHANGES_SUBPROTOCOL: &str = "narsil.changes.v1";
pub(crate) const CLOSE_GOING_AWAY: u16 = 1001;
pub(crate) const CLOSE_POLICY: u16 = 1008;
pub(crate) const CLOSE_TOO_LARGE: u16 = 1009;
pub(crate) const CLOSE_SERVER_ERROR: u16 = 1011;
pub(crate) const CLOSE_CREDENTIAL_EXPIRED: u16 = 4401;
pub(crate) const CLOSE_SETTING: u16 = 4409;
pub(crate) const CLOSE_RESYNC: u16 = 4410;

const MAX_UINT32: f64 = 4_294_967_295.0;
const SYNC_EPOCH_DIGITS: usize = 32;
const FIXARRAY_LIMIT: usize = 16;
const ARRAY16_LIMIT: usize = 65_536;
const FIXARRAY_TAG: u8 = 0x90;
const ARRAY16_TAG: u8 = 0xdc;
const ARRAY32_TAG: u8 = 0xdd;
const FIXMAP_OF_THREE: u8 = 0x83;
const TYPE_KEY: &[u8] = b"\xa4type";
const ENTRIES_KEY: &[u8] = b"\xa7entries";
const PARTITION_ID_KEY: &[u8] = b"\xabpartitionId";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Position {
    pub(crate) partition_id: u32,
    pub(crate) seq_no: u64,
}

pub(crate) enum DeviceMessage {
    Subscribe {
        epoch: String,
        positions: Vec<Position>,
    },
    Ack(Vec<Position>),
    Checkpoint(u32),
}

pub(crate) enum SubscriberMessage {
    Subscribe {
        resume: Option<(String, Vec<Position>)>,
        filter: Option<Value>,
    },
    Ack(Vec<Position>),
}

fn whole_number_up_to(value: Option<&Value>, max: f64) -> Option<f64> {
    whole_number(value?).filter(|number| (0.0..=max).contains(number))
}

fn positions_of(raw: Option<&Value>) -> Option<Vec<Position>> {
    let Some(Value::Array(items)) = raw else {
        return None;
    };
    let mut positions = Vec::with_capacity(items.len());
    for item in items {
        let Value::Object(item) = item else {
            return None;
        };
        let partition_id = whole_number_up_to(item.get("partitionId"), MAX_UINT32)?;
        let seq_no = whole_number_up_to(item.get("seqNo"), MAX_SAFE_INTEGER as f64)?;
        positions.push(Position {
            partition_id: partition_id as u32,
            seq_no: seq_no as u64,
        });
    }
    Some(positions)
}

fn epoch_of(raw: Option<&Value>) -> Option<String> {
    match raw {
        Some(Value::String(epoch))
            if epoch.len() == SYNC_EPOCH_DIGITS
                && epoch
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) =>
        {
            Some(epoch.clone())
        }
        _ => None,
    }
}

fn record_of(bytes: &[u8]) -> Option<Map> {
    match decode_msgpack(bytes) {
        Ok(Value::Object(record)) => Some(record),
        _ => None,
    }
}

fn absent(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null))
}

pub(crate) fn device_message_of(bytes: &[u8]) -> Option<DeviceMessage> {
    let record = record_of(bytes)?;
    match record.get("type").and_then(Value::as_str)? {
        "subscribe" => {
            let positions = positions_of(record.get("positions"))?;
            let epoch = epoch_of(record.get("epoch"))?;
            Some(DeviceMessage::Subscribe { epoch, positions })
        }
        "ack" => positions_of(record.get("positions")).map(DeviceMessage::Ack),
        "checkpoint" => whole_number_up_to(record.get("id"), MAX_UINT32)
            .map(|id| DeviceMessage::Checkpoint(id as u32)),
        _ => None,
    }
}

pub(crate) fn subscriber_message_of(bytes: &[u8]) -> Option<SubscriberMessage> {
    let mut record = record_of(bytes)?;
    match record.get("type").and_then(Value::as_str)? {
        "subscribe" => {
            let epoch_absent = absent(record.get("epoch"));
            if epoch_absent != absent(record.get("positions")) {
                return None;
            }
            let filter = match record.remove("filter") {
                None | Some(Value::Null) => None,
                Some(filter) => Some(filter),
            };
            if epoch_absent {
                return Some(SubscriberMessage::Subscribe {
                    resume: None,
                    filter,
                });
            }
            let positions = positions_of(record.get("positions"))?;
            let epoch = epoch_of(record.get("epoch"))?;
            Some(SubscriberMessage::Subscribe {
                resume: Some((epoch, positions)),
                filter,
            })
        }
        "ack" => positions_of(record.get("positions")).map(SubscriberMessage::Ack),
        _ => None,
    }
}

pub(crate) fn seq_nos_by_partition(
    positions: &[Position],
    partition_count: usize,
) -> Option<Vec<u64>> {
    if positions.len() != partition_count {
        return None;
    }
    let mut seq_nos: Vec<Option<u64>> = vec![None; partition_count];
    for position in positions {
        let slot = seq_nos.get_mut(position.partition_id as usize)?;
        if slot.is_some() {
            return None;
        }
        *slot = Some(position.seq_no);
    }
    seq_nos.into_iter().collect()
}

pub(crate) fn position_list(seq_nos: &[u64]) -> Value {
    Value::Array(
        seq_nos
            .iter()
            .enumerate()
            .map(|(partition_id, seq_no)| {
                let mut position = Map::with_capacity(2);
                position.insert("partitionId", Value::Number(partition_id as f64));
                position.insert("seqNo", Value::Number(*seq_no as f64));
                Value::Object(position)
            })
            .collect(),
    )
}

pub(crate) fn message(kind: &str, fields: Vec<(&str, Value)>) -> Option<Vec<u8>> {
    let mut record = Map::with_capacity(fields.len() + 1);
    record.insert("type", Value::String(kind.to_string()));
    for (key, value) in fields {
        record.insert(key, value);
    }
    encode_msgpack(&Value::Object(record)).ok()
}

pub(crate) fn resync_message(reason: &str) -> Option<Vec<u8>> {
    message(
        "resync",
        vec![("reason", Value::String(reason.to_string()))],
    )
}

fn array_header(count: usize, into: &mut Vec<u8>) {
    if count < FIXARRAY_LIMIT {
        into.push(FIXARRAY_TAG | count as u8);
    } else if count < ARRAY16_LIMIT {
        into.push(ARRAY16_TAG);
        into.extend_from_slice(&(count as u16).to_be_bytes());
    } else {
        into.push(ARRAY32_TAG);
        into.extend_from_slice(&(count.min(u32::MAX as usize) as u32).to_be_bytes());
    }
}

pub(crate) fn entries_message(partition_id: u32, payloads: &[&[u8]]) -> Option<Vec<u8>> {
    let partition = encode_msgpack(&Value::Number(partition_id as f64)).ok()?;
    let payload_bytes: usize = payloads.iter().map(|payload| payload.len()).sum();
    let mut out = Vec::with_capacity(payload_bytes.saturating_add(64));
    out.push(FIXMAP_OF_THREE);
    out.extend_from_slice(TYPE_KEY);
    out.extend_from_slice(ENTRIES_KEY);
    out.extend_from_slice(PARTITION_ID_KEY);
    out.extend_from_slice(&partition);
    out.extend_from_slice(ENTRIES_KEY);
    array_header(payloads.len(), &mut out);
    for payload in payloads {
        out.extend_from_slice(payload);
    }
    Some(out)
}

pub(crate) fn close_reason_of(reason: &str) -> String {
    if reason.len() <= MAX_CLOSE_REASON_BYTES {
        return reason.to_string();
    }
    let mut kept = String::with_capacity(MAX_CLOSE_REASON_BYTES);
    for character in reason.chars() {
        if kept.len() + character.len_utf8() > MAX_CLOSE_REASON_BYTES {
            break;
        }
        kept.push(character);
    }
    kept
}
