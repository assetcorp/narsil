use narsil::{Map, Value, parse_plain_json, write_plain_json};

use super::constants::{DELIVERY_ID_BYTES, RETRY_DELAYS_MS};
use crate::events::body::is_iso_timestamp;
use crate::events::types::is_event_type;

pub const KEY_SUFFIX: &str = ".json";
const DELIVERY_ID_PREFIX: &str = "msg_";
const LARGEST_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

#[derive(Debug, Clone, PartialEq)]
pub struct Delivery {
    pub id: String,
    pub event_type: String,
    pub body: String,
    pub enqueued_at: u64,
    pub sequence: u64,
    pub failed_tries: u64,
    pub due_at: u64,
}

pub fn key_of(id: &str) -> String {
    format!("{id}{KEY_SUFFIX}")
}

pub fn is_delivery_id(id: &str) -> bool {
    id.strip_prefix(DELIVERY_ID_PREFIX).is_some_and(|hex| {
        hex.len() == DELIVERY_ID_BYTES * 2
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

pub fn is_delivery_key(key: &str) -> bool {
    key.strip_suffix(KEY_SUFFIX).is_some_and(is_delivery_id)
}

pub fn random_delivery_id() -> Option<String> {
    let mut bytes = [0u8; DELIVERY_ID_BYTES];
    getrandom::fill(&mut bytes).ok()?;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Some(format!("{DELIVERY_ID_PREFIX}{hex}"))
}

pub fn random_fraction() -> f64 {
    let mut bytes = [0u8; 4];
    if getrandom::fill(&mut bytes).is_err() {
        return 0.0;
    }
    f64::from(u32::from_le_bytes(bytes)) / (f64::from(u32::MAX) + 1.0)
}

fn whole_number(fields: &Map, key: &str) -> Option<u64> {
    let number = fields.get(key)?.as_f64()?;
    (number.fract() == 0.0 && (0.0..=LARGEST_SAFE_INTEGER).contains(&number))
        .then_some(number as u64)
}

fn valid_body(body: &str, event_type: &str) -> bool {
    let Ok(Value::Object(fields)) = parse_plain_json(body) else {
        return false;
    };
    fields.get("type").and_then(Value::as_str) == Some(event_type)
        && fields.contains_key("data")
        && fields
            .get("timestamp")
            .and_then(Value::as_str)
            .is_some_and(is_iso_timestamp)
}

impl Delivery {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut fields = Map::new();
        fields.insert("id", Value::String(self.id.clone()));
        fields.insert("type", Value::String(self.event_type.clone()));
        fields.insert("body", Value::String(self.body.clone()));
        fields.insert("enqueuedAt", Value::Number(self.enqueued_at as f64));
        fields.insert("sequence", Value::Number(self.sequence as f64));
        fields.insert("failedTries", Value::Number(self.failed_tries as f64));
        fields.insert("dueAt", Value::Number(self.due_at as f64));
        write_plain_json(&Value::Object(fields)).into_bytes()
    }

    pub fn parse(key: &str, bytes: &[u8]) -> Option<Delivery> {
        let text = std::str::from_utf8(bytes).ok()?;
        let Ok(Value::Object(fields)) = parse_plain_json(text) else {
            return None;
        };
        let id = fields.get("id")?.as_str()?.to_string();
        if !is_delivery_id(&id) || key != key_of(&id) {
            return None;
        }
        let event_type = fields.get("type")?.as_str()?.to_string();
        let body = fields.get("body")?.as_str()?.to_string();
        if !is_event_type(&event_type) {
            return None;
        }
        let delivery = Delivery {
            id,
            enqueued_at: whole_number(&fields, "enqueuedAt")?,
            sequence: whole_number(&fields, "sequence")?,
            failed_tries: whole_number(&fields, "failedTries")?,
            due_at: whole_number(&fields, "dueAt")?,
            event_type,
            body,
        };
        let usable = delivery.failed_tries <= RETRY_DELAYS_MS.len() as u64
            && valid_body(&delivery.body, &delivery.event_type);
        usable.then_some(delivery)
    }
}
