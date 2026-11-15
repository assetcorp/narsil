use narsil::{ErrorCode, Map, Value};

use crate::errors::ServerError;
use crate::script_values::script_text;

const REQUIRED_FIELD_MESSAGE_START: &str = "Required field \"";

fn pattern_value_limit_as_given(given: &Value) -> Value {
    match given {
        Value::Number(_) => given.clone(),
        other => Value::String(script_text(other)),
    }
}

fn required_entry_as_given(http: &Map, field: &Value) -> Option<Value> {
    let Value::String(field) = field else {
        return None;
    };
    let Some(Value::Array(entries)) = http.get("required") else {
        return None;
    };
    entries
        .iter()
        .find(|entry| !matches!(entry, Value::String(_)) && script_text(entry) == *field)
        .cloned()
}

fn given_detail(error: &ServerError, http: &Map, key: &str, value: &Value) -> Option<Value> {
    let code = error.code.as_str();
    match key {
        "patternValueLimit" if code == ErrorCode::CONFIG_INVALID.as_str() => http
            .get("patternValueLimit")
            .map(pattern_value_limit_as_given),
        "language" if code == ErrorCode::LANGUAGE_NOT_SUPPORTED.as_str() => http
            .get("language")
            .filter(|given| !given.is_null())
            .cloned(),
        "field"
            if code == ErrorCode::EMBEDDING_CONFIG_INVALID.as_str()
                && error.message.starts_with(REQUIRED_FIELD_MESSAGE_START) =>
        {
            required_entry_as_given(http, value)
        }
        _ => None,
    }
}

pub(crate) fn with_given_values(mut error: ServerError, http: &Map) -> ServerError {
    let Some(details) = error.details.take() else {
        return error;
    };
    let mut restored = Map::with_capacity(details.len());
    for (key, value) in details {
        let given = given_detail(&error, http, &key, &value).unwrap_or(value);
        restored.insert(key, given);
    }
    error.details = Some(restored);
    error
}
