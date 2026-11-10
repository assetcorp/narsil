use crate::util::base64;
use crate::value::{Value, number_to_text};

fn write_string_json(out: &mut String, text: &str) {
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            control if (control as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", control as u32))
            }
            other => out.push(other),
        }
    }
    out.push('"');
}

fn write_number_json(out: &mut String, number: f64, tagged: bool) {
    if number.is_finite() || !tagged {
        if number == 0.0 && number.is_sign_negative() {
            out.push_str("-0");
        } else if number.is_finite() {
            out.push_str(&number_to_text(number));
        } else {
            out.push_str("null");
        }
        return;
    }
    out.push_str("{\"$number\":\"");
    out.push_str(&number_to_text(number));
    out.push_str("\"}");
}

fn write_value_json(out: &mut String, value: &Value, tagged: bool) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => write_number_json(out, *number, tagged),
        Value::String(text) => write_string_json(out, text),
        Value::Bytes(bytes) => {
            out.push_str("{\"$bytes\":\"");
            out.push_str(&base64::encode(bytes));
            out.push_str("\"}");
        }
        Value::Timestamp(timestamp) => {
            out.push_str(&format!(
                "{{\"$date\":[{},{}]}}",
                timestamp.seconds, timestamp.nanoseconds
            ));
        }
        Value::Array(items) => {
            out.push('[');
            for (at, item) in items.iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                write_value_json(out, item, tagged);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let wrapped = tagged
                && map.len() == 1
                && map.keys().next().is_some_and(|key| key.starts_with('$'));
            out.push_str(if wrapped { "{\"$object\":{" } else { "{" });
            for (at, (key, entry)) in map.iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                write_string_json(out, key);
                out.push(':');
                write_value_json(out, entry, tagged);
            }
            out.push_str(if wrapped { "}}" } else { "}" });
        }
    }
}

/// Writes `value` as JSON text, with a `$date`, `$bytes`, `$number`, or `$object` tag for each value that JSON has
/// no type for, as a Narsil document export writes it.
pub fn write_json(value: &Value) -> String {
    let mut out = String::new();
    write_value_json(&mut out, value, true);
    out
}

pub(crate) fn write_json_into(out: &mut String, value: &Value) {
    write_value_json(out, value, true);
}

pub(crate) fn write_exact_json_into(out: &mut String, value: &Value) {
    write_value_json(out, value, false);
}
