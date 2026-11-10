use super::{config_invalid, positive_integer};
use crate::error::{NarsilError, Result};
use crate::value::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct SyncSetting {
    pub(crate) enabled: bool,
    pub(crate) history_max_age_ms: Option<u64>,
    pub(crate) history_max_bytes: Option<u64>,
}

fn sync_invalid(message: &str) -> NarsilError {
    config_invalid(format!(
        "The device sync state in the index metadata {message}"
    ))
}

pub(crate) fn sync_from_wire(value: &Value) -> Result<SyncSetting> {
    let Value::Object(map) = value else {
        return Err(sync_invalid("holds a sync setting that is not a map"));
    };
    let Some(Value::Bool(enabled)) = map.get("enabled") else {
        return Err(sync_invalid(
            "holds a sync setting without a boolean enabled",
        ));
    };
    let limit = |key: &str, message: &str| -> Result<Option<u64>> {
        match map.get(key) {
            None => Ok(None),
            Some(value) => positive_integer(Some(value))
                .map(Some)
                .ok_or_else(|| sync_invalid(message)),
        }
    };
    Ok(SyncSetting {
        enabled: *enabled,
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

pub(crate) fn sync_to_wire(setting: &SyncSetting) -> Value {
    let mut map = Map::new();
    map.insert("enabled", Value::Bool(setting.enabled));
    if let Some(age) = setting.history_max_age_ms {
        map.insert("history_max_age_ms", Value::Number(age as f64));
    }
    if let Some(bytes) = setting.history_max_bytes {
        map.insert("history_max_bytes", Value::Number(bytes as f64));
    }
    Value::Object(map)
}
