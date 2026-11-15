use narsil::{Value, write_plain_json};

use super::constants::DISPLAYED_NAME_UTF16_UNITS;

pub(crate) fn number_text(number: f64) -> String {
    if number.is_nan() {
        "NaN".to_string()
    } else if number == f64::INFINITY {
        "Infinity".to_string()
    } else if number == f64::NEG_INFINITY {
        "-Infinity".to_string()
    } else {
        write_plain_json(&Value::Number(number))
    }
}

pub(crate) fn string_of(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number_text(*number),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => string_of(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        _ => "[object Object]".to_string(),
    }
}

pub(crate) fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null | Value::Array(_) | Value::Object(_) => "object",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        _ => "object",
    }
}

pub(crate) fn utf16_prefix(text: &str, units: usize) -> &str {
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
        Value::Number(_) | Value::Bool(_) | Value::Null => string_of(value),
        other => format!("a value of type {}", type_name(other)),
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

pub(crate) fn is_falsy(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Bool(flag) => !flag,
        Value::Number(number) => *number == 0.0 || number.is_nan(),
        Value::String(text) => text.is_empty(),
        _ => false,
    }
}

pub(crate) fn is_whole_number(number: f64) -> bool {
    number.is_finite() && number.trunc() == number
}
