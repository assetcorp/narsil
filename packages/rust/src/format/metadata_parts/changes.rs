use super::{config_invalid, positive_integer};
use crate::error::{NarsilError, Result};
use crate::value::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ChangesSetting {
    pub(crate) enabled: bool,
    pub(crate) previous_document: Option<bool>,
    pub(crate) history_max_age_ms: Option<u64>,
    pub(crate) history_max_bytes: Option<u64>,
}

impl ChangesSetting {
    pub(crate) fn records_previous_documents(&self) -> bool {
        self.enabled && self.previous_document == Some(true)
    }
}

fn changes_invalid(message: &str) -> NarsilError {
    config_invalid(format!(
        "The change capture setting in the index metadata {message}"
    ))
}

pub(crate) fn changes_from_wire(value: &Value) -> Result<ChangesSetting> {
    let Value::Object(map) = value else {
        return Err(changes_invalid("is not a map"));
    };
    let Some(Value::Bool(enabled)) = map.get("enabled") else {
        return Err(changes_invalid("holds no boolean enabled"));
    };
    let previous_document = match map.get("previous_document") {
        None | Some(Value::Null) => None,
        Some(Value::Bool(flag)) => Some(*flag),
        Some(_) => {
            return Err(changes_invalid(
                "holds a previous_document that is not a boolean",
            ));
        }
    };
    let limit = |key: &str, message: &str| -> Result<Option<u64>> {
        match map.get(key) {
            None => Ok(None),
            Some(value) => positive_integer(Some(value))
                .map(Some)
                .ok_or_else(|| changes_invalid(message)),
        }
    };
    Ok(ChangesSetting {
        enabled: *enabled,
        previous_document,
        history_max_age_ms: limit(
            "history_max_age_ms",
            "holds a history age limit that is not a positive whole number",
        )?,
        history_max_bytes: limit(
            "history_max_bytes",
            "holds a history byte limit that is not a positive whole number",
        )?,
    })
}

pub(crate) fn changes_to_wire(setting: &ChangesSetting) -> Value {
    let mut map = Map::new();
    map.insert("enabled", Value::Bool(setting.enabled));
    if let Some(previous) = setting.previous_document {
        map.insert("previous_document", Value::Bool(previous));
    }
    if let Some(age) = setting.history_max_age_ms {
        map.insert("history_max_age_ms", Value::Number(age as f64));
    }
    if let Some(bytes) = setting.history_max_bytes {
        map.insert("history_max_bytes", Value::Number(bytes as f64));
    }
    Value::Object(map)
}
