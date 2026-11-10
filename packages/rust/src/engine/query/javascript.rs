use crate::util::text::javascript_trim;
use crate::value::{Value, number_to_text};

const PLAIN_OBJECT_TEXT: &str = "[object Object]";

pub(crate) fn write_json_text(out: &mut String, text: &str) {
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
            control if u32::from(control) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", u32::from(control)))
            }
            other => out.push(other),
        }
    }
    out.push('"');
}

pub(crate) fn utf16_length(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

fn write_joined_member(out: &mut String, value: &Value) {
    if !value.is_null() {
        write_javascript_string(out, value);
    }
}

pub(crate) fn write_javascript_string(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => out.push_str(&number_to_text(*number)),
        Value::String(text) => out.push_str(text),
        Value::Bytes(bytes) => {
            for (at, byte) in bytes.iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                out.push_str(&byte.to_string());
            }
        }
        Value::Array(items) => {
            for (at, item) in items.iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                write_joined_member(out, item);
            }
        }
        Value::Timestamp(_) | Value::Object(_) => out.push_str(PLAIN_OBJECT_TEXT),
    }
}

pub(crate) fn javascript_string(value: &Value) -> String {
    let mut out = String::new();
    write_javascript_string(&mut out, value);
    out
}

fn radix_number(digits: &str, radix: u32) -> f64 {
    if digits.is_empty() {
        return f64::NAN;
    }
    let mut number = 0.0;
    for character in digits.chars() {
        let Some(digit) = character.to_digit(radix) else {
            return f64::NAN;
        };
        number = number * f64::from(radix) + f64::from(digit);
    }
    number
}

fn is_decimal_literal(text: &str) -> bool {
    text.bytes()
        .all(|byte| matches!(byte, b'0'..=b'9' | b'+' | b'-' | b'.' | b'e' | b'E'))
}

fn string_to_number(text: &str) -> f64 {
    let trimmed = javascript_trim(text);
    if trimmed.is_empty() {
        return 0.0;
    }
    match trimmed {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let prefixed = [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ];
    for (prefix, radix) in prefixed {
        if let Some(digits) = trimmed.strip_prefix(prefix) {
            return radix_number(digits, radix);
        }
    }
    if !is_decimal_literal(trimmed) {
        return f64::NAN;
    }
    trimmed.parse::<f64>().unwrap_or(f64::NAN)
}

pub(crate) fn javascript_to_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::Number(number) => *number,
        Value::String(text) => string_to_number(text),
        Value::Array(_) | Value::Bytes(_) => string_to_number(&javascript_string(value)),
        Value::Timestamp(_) | Value::Object(_) => f64::NAN,
    }
}
