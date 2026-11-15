use narsil::{Value, write_plain_json};

use crate::constants::DISPLAYED_NAME_UTF16_UNITS;

pub(crate) fn script_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) if number.is_nan() => "NaN".to_string(),
        Value::Number(number) if number.is_infinite() && *number > 0.0 => "Infinity".to_string(),
        Value::Number(number) if number.is_infinite() => "-Infinity".to_string(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => script_text(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
        other => write_plain_json(other),
    }
}

pub(crate) fn script_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => *number != 0.0 && !number.is_nan(),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

pub(crate) fn script_type_name(value: &Value) -> &'static str {
    match value {
        Value::Null
        | Value::Array(_)
        | Value::Object(_)
        | Value::Bytes(_)
        | Value::Timestamp(_) => "object",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
    }
}

pub(crate) fn is_whole_number(number: f64) -> bool {
    number.is_finite() && number.fract() == 0.0
}

pub(crate) fn whole_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) if is_whole_number(*number) => Some(*number),
        _ => None,
    }
}

pub(crate) fn saturating_count(number: f64) -> u64 {
    if number <= 0.0 {
        0
    } else if number >= u64::MAX as f64 {
        u64::MAX
    } else {
        number as u64
    }
}

fn utf16_prefix(text: &str, units: usize) -> &str {
    let mut taken = 0usize;
    for (at, character) in text.char_indices() {
        let width = character.len_utf16();
        if taken + width > units {
            return text.get(..at).unwrap_or(text);
        }
        taken += width;
    }
    text
}

pub(crate) fn displayed_name(name: &str) -> &str {
    utf16_prefix(name, DISPLAYED_NAME_UTF16_UNITS)
}

pub(crate) fn displayed(value: &Value) -> String {
    match value {
        Value::String(text) => format!("\"{}\"", displayed_name(text)),
        Value::Number(_) | Value::Bool(_) | Value::Null => script_text(value),
        other => format!("a value of type {}", script_type_name(other)),
    }
}

fn is_javascript_space(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

pub(crate) fn javascript_trim(text: &str) -> &str {
    text.trim_matches(is_javascript_space)
}
