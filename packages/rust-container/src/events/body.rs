use std::time::{SystemTime, UNIX_EPOCH};

use narsil::{Map, NarsilError, Timestamp, Value, write_plain_json};

const MS_PER_SECOND: i64 = 1_000;
const NANOSECONDS_PER_MS: i64 = 1_000_000;
const ISO_TIMESTAMP_BYTES: usize = 24;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn timestamp_of(ms: u64) -> Value {
    let ms = i64::try_from(ms).unwrap_or(i64::MAX);
    let nanoseconds = ms.rem_euclid(MS_PER_SECOND) * NANOSECONDS_PER_MS;
    Value::Timestamp(Timestamp {
        seconds: ms.div_euclid(MS_PER_SECOND),
        nanoseconds: u32::try_from(nanoseconds).unwrap_or(0),
    })
}

pub fn delivery_body(event_type: &str, data: Value, now_ms: u64) -> String {
    let mut body = Map::new();
    body.insert("type", Value::String(event_type.to_string()));
    body.insert("timestamp", timestamp_of(now_ms));
    body.insert("data", data);
    write_plain_json(&Value::Object(body))
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let shifted_month = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn digits_at(bytes: &[u8], from: usize, count: usize) -> Option<i64> {
    let slice = bytes.get(from..from + count)?;
    slice.iter().try_fold(0i64, |total, byte| {
        byte.is_ascii_digit()
            .then(|| total * 10 + i64::from(byte - b'0'))
    })
}

fn milliseconds_of_iso(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    let separators = [
        (4, b'-'),
        (7, b'-'),
        (10, b'T'),
        (13, b':'),
        (16, b':'),
        (19, b'.'),
        (23, b'Z'),
    ];
    if bytes.len() != ISO_TIMESTAMP_BYTES
        || separators
            .iter()
            .any(|(at, byte)| bytes.get(*at) != Some(byte))
    {
        return None;
    }
    let days = days_from_civil(
        digits_at(bytes, 0, 4)?,
        digits_at(bytes, 5, 2)?,
        digits_at(bytes, 8, 2)?,
    );
    let seconds = days * 86_400
        + digits_at(bytes, 11, 2)? * 3_600
        + digits_at(bytes, 14, 2)? * 60
        + digits_at(bytes, 17, 2)?;
    Some(seconds * MS_PER_SECOND + digits_at(bytes, 20, 3)?)
}

pub fn is_iso_timestamp(text: &str) -> bool {
    let Some(ms) = milliseconds_of_iso(text).and_then(|ms| u64::try_from(ms).ok()) else {
        return false;
    };
    write_plain_json(&timestamp_of(ms)) == write_plain_json(&Value::String(text.to_string()))
}

pub fn error_value(error: &NarsilError) -> Value {
    let mut fields = Map::new();
    fields.insert("name", Value::String("NarsilError".to_string()));
    fields.insert("message", Value::String(error.message().to_string()));
    fields.insert("code", Value::String(error.code().as_str().to_string()));
    Value::Object(fields)
}

pub fn object(entries: Vec<(&str, Value)>) -> Value {
    let mut fields = Map::with_capacity(entries.len());
    for (key, value) in entries {
        fields.insert(key, value);
    }
    Value::Object(fields)
}
