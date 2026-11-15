use narsil::{ChangesSetting, ChangesStatus, Map, SyncSetting, SyncStatus, Value};

use super::errors::config_invalid;
use super::js_text::{is_whole_number, string_of};
use crate::constants::MAX_SAFE_INTEGER;
use crate::errors::Outcome;
use crate::handlers::common::object;

#[derive(Clone, Copy)]
enum Feature {
    Sync,
    Changes,
}

impl Feature {
    fn name(self) -> &'static str {
        match self {
            Feature::Sync => "sync",
            Feature::Changes => "changes",
        }
    }
}

fn limit_of(feature: Feature, fields: Option<&Map>, name: &str) -> Outcome<Option<u64>> {
    let Some(value) = fields.and_then(|fields| fields.get(name)) else {
        return Ok(None);
    };
    match value {
        Value::Number(number)
            if is_whole_number(*number) && *number >= 1.0 && *number <= MAX_SAFE_INTEGER as f64 =>
        {
            Ok(Some(*number as u64))
        }
        other => Err(config_invalid(format!(
            "The {} setting {name} must be a positive whole number",
            feature.name()
        ))
        .with_detail(name, Value::String(string_of(other)))),
    }
}

fn enabled_of(feature: Feature, fields: Option<&Map>) -> Outcome<bool> {
    match fields.and_then(|fields| fields.get("enabled")) {
        Some(Value::Bool(enabled)) => Ok(*enabled),
        _ => Err(config_invalid(format!(
            "The {} setting needs enabled set to true or false",
            feature.name()
        ))),
    }
}

pub(crate) fn sync_setting_of(body: &Value) -> Outcome<SyncSetting> {
    let fields = match body {
        Value::Object(fields) => Some(fields),
        Value::Array(_) => None,
        _ => return Err(config_invalid("The sync setting must be an object")),
    };
    let enabled = enabled_of(Feature::Sync, fields)?;
    Ok(SyncSetting {
        enabled,
        history_max_age_ms: limit_of(Feature::Sync, fields, "historyMaxAgeMs")?,
        history_max_bytes: limit_of(Feature::Sync, fields, "historyMaxBytes")?,
    })
}

pub(crate) fn changes_setting_of(body: &Value) -> Outcome<ChangesSetting> {
    let Value::Object(fields) = body else {
        return Err(config_invalid("The changes setting must be an object"));
    };
    let enabled = enabled_of(Feature::Changes, Some(fields))?;
    let previous_document = match fields.get("previousDocument") {
        None => false,
        Some(Value::Bool(flag)) => *flag,
        Some(_) => {
            return Err(config_invalid(
                "The changes setting previousDocument must be true or false",
            ));
        }
    };
    Ok(ChangesSetting {
        enabled,
        previous_document,
        history_max_age_ms: limit_of(Feature::Changes, Some(fields), "historyMaxAgeMs")?,
        history_max_bytes: limit_of(Feature::Changes, Some(fields), "historyMaxBytes")?,
    })
}

fn push_limits(entries: &mut Vec<(&str, Value)>, age: Option<u64>, bytes: Option<u64>) {
    if let Some(age) = age {
        entries.push(("historyMaxAgeMs", Value::Number(age as f64)));
    }
    if let Some(bytes) = bytes {
        entries.push(("historyMaxBytes", Value::Number(bytes as f64)));
    }
}

fn epoch_value(epoch: Option<String>) -> Value {
    epoch.map_or(Value::Null, Value::String)
}

pub(crate) fn sync_status_json(status: SyncStatus) -> Value {
    if !status.enabled {
        return object(vec![
            ("enabled", Value::Bool(false)),
            ("active", Value::Bool(false)),
            ("epoch", Value::Null),
        ]);
    }
    let mut entries = vec![("enabled", Value::Bool(true))];
    push_limits(
        &mut entries,
        status.history_max_age_ms,
        status.history_max_bytes,
    );
    entries.push(("active", Value::Bool(status.active)));
    entries.push(("epoch", epoch_value(status.epoch)));
    object(entries)
}

pub(crate) fn changes_status_json(status: ChangesStatus) -> Value {
    if !status.enabled {
        return object(vec![
            ("enabled", Value::Bool(false)),
            ("previousDocument", Value::Bool(false)),
            ("epoch", Value::Null),
        ]);
    }
    let mut entries = vec![
        ("enabled", Value::Bool(true)),
        ("previousDocument", Value::Bool(status.previous_document)),
    ];
    push_limits(
        &mut entries,
        status.history_max_age_ms,
        status.history_max_bytes,
    );
    entries.push(("epoch", epoch_value(status.epoch)));
    object(entries)
}
