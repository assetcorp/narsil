use narsil::{Value, write_plain_json};

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

pub(crate) fn whole_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) if number.is_finite() && number.fract() == 0.0 => Some(*number),
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
