use super::parse::parse_json_raw;
use super::write::write_json_string;
use crate::error::Result;
use crate::value::{Timestamp, Value, number_to_text};

/// Parses JSON text into a [`Value`] as `JSON.parse` reads it, keeping an object whose only key starts with `$`
/// as that object, so that an HTTP body holds exactly the fields that its sender wrote.
///
/// # Errors
///
/// Returns `DOC_VALIDATION_FAILED` where the text is not one JSON value, or where it nests deeper than 512 levels.
pub fn parse_plain_json(text: &str) -> Result<Value> {
    parse_json_raw(text)
}

/// Writes `value` as JSON text as `JSON.stringify` writes the same value in the TypeScript engine: a non-finite
/// number and negative zero as `null` and `0`, bytes as an array of numbers, and a timestamp as its ISO 8601 text
/// in milliseconds, with no tag objects.
pub fn write_plain_json(value: &Value) -> String {
    let mut out = String::new();
    write_plain_json_into(&mut out, value);
    out
}

/// Appends the text that [`write_plain_json`] returns for `value` to `out`.
pub fn write_plain_json_into(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => write_plain_number(out, *number),
        Value::String(text) => write_json_string(out, text),
        Value::Bytes(bytes) => {
            out.push('[');
            for (at, byte) in bytes.iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                out.push_str(&byte.to_string());
            }
            out.push(']');
        }
        Value::Timestamp(timestamp) => write_plain_timestamp(out, timestamp),
        Value::Array(items) => {
            out.push('[');
            for (at, item) in items.iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                write_plain_json_into(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (at, (key, entry)) in map.iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                write_json_string(out, key);
                out.push(':');
                write_plain_json_into(out, entry);
            }
            out.push('}');
        }
    }
}

fn write_plain_number(out: &mut String, number: f64) {
    if !number.is_finite() {
        out.push_str("null");
    } else if number == 0.0 {
        out.push('0');
    } else {
        out.push_str(&number_to_text(number));
    }
}

fn write_plain_timestamp(out: &mut String, timestamp: &Timestamp) {
    let milliseconds = timestamp.nanoseconds / 1_000_000;
    let Ok(instant) = jiff::Timestamp::new(timestamp.seconds, 0) else {
        out.push_str("null");
        return;
    };
    let civil = instant.to_zoned(jiff::tz::TimeZone::UTC);
    let year = civil.year();
    if !(0..=9999).contains(&year) {
        out.push_str("null");
        return;
    }
    out.push_str(&format!(
        "\"{year:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{milliseconds:03}Z\"",
        civil.month(),
        civil.day(),
        civil.hour(),
        civil.minute(),
        civil.second()
    ));
}
