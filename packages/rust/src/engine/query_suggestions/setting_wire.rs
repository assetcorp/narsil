use super::constants::MAX_SOURCE_INDEX_NAME_LENGTH;
use super::phrase::is_group;
use super::setting::{QuerySuggestionsSetting, RANGES, invalid_setting, validate_setting};
use crate::error::Result;
use crate::value::{Map, Value, encode_value};

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// The spelling of a setting's keys: snake_case in the index metadata, camelCase in the index configuration
/// payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KeyCase {
    Snake,
    Camel,
}

/// The index and the group that a suggestions index serves.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct QuerySuggestionsSource {
    /// The index whose searches the suggestions come from.
    pub index: String,
    /// The group whose searches the suggestions come from.
    pub group: String,
}

/// Returns a setting as the map that a file holds, with only the limits that the setting gives.
pub(crate) fn setting_to_wire(setting: &QuerySuggestionsSetting, case: KeyCase) -> Value {
    let mut wire = Map::new();
    wire.insert("enabled", Value::Bool(setting.enabled));
    wire.insert(
        "fields",
        Value::Array(setting.fields.iter().cloned().map(Value::String).collect()),
    );
    for range in &RANGES {
        if let Some(value) = (range.get)(setting) {
            let key = if case == KeyCase::Snake {
                range.wire
            } else {
                range.key
            };
            wire.insert(key, Value::Number(value as f64));
        }
    }
    if let Some(schedule) = &setting.schedule {
        wire.insert("schedule", Value::String(schedule.clone()));
    }
    if let Some(time_zone) = &setting.time_zone {
        let key = if case == KeyCase::Snake {
            "time_zone"
        } else {
            "timeZone"
        };
        wire.insert(key, Value::String(time_zone.clone()));
    }
    Value::Object(wire)
}

/// Returns the length of the MessagePack encoding that the metadata holds for `setting`.
pub(crate) fn setting_wire_bytes(setting: &QuerySuggestionsSetting) -> usize {
    encode_value(&setting_to_wire(setting, KeyCase::Snake)).map_or(usize::MAX, |bytes| bytes.len())
}

fn whole_number(value: &Value, key: &str) -> Result<u64> {
    let Some(number) = value.as_f64() else {
        return Err(invalid_setting(format!("{key} must be a whole number")));
    };
    if !number.is_finite() || number.fract() != 0.0 || number.abs() > MAX_SAFE_INTEGER {
        return Err(invalid_setting(format!("{key} must be a whole number")));
    }
    if number < 0.0 {
        return Err(invalid_setting(format!(
            "{key} must not be negative, got {number}"
        )));
    }
    Ok(number as u64)
}

fn fields_of(value: Option<&Value>) -> Result<Vec<String>> {
    let Some(Value::Array(items)) = value else {
        return Err(invalid_setting(
            "The query suggestions setting needs an array of fields",
        ));
    };
    items
        .iter()
        .map(|item| match item {
            Value::String(text) => Ok(text.clone()),
            _ => Err(invalid_setting(
                "Each field of the query suggestions setting must be a distinct, non-empty path",
            )),
        })
        .collect()
}

fn text_of(value: &Value, key: &str) -> Result<String> {
    match value {
        Value::String(text) => Ok(text.clone()),
        _ => Err(invalid_setting(format!("{key} must be a string"))),
    }
}

fn store_number(
    setting: &mut QuerySuggestionsSetting,
    key: &str,
    value: &Value,
    case: KeyCase,
) -> Result<bool> {
    for range in &RANGES {
        let name = if case == KeyCase::Snake {
            range.wire
        } else {
            range.key
        };
        if name != key {
            continue;
        }
        let number = whole_number(value, range.key)?;
        if number > u64::from(u32::MAX) && range.key != "mergeMemoryBytes" {
            return Err(invalid_setting(format!(
                "{} is out of range, got {number}",
                range.key
            )));
        }
        (range.set)(setting, number);
        return Ok(true);
    }
    Ok(false)
}

/// Reads a stored setting, refusing with `CONFIG_INVALID` a key that the setting lacks and any value that breaks
/// a rule of the specification.
pub(crate) fn setting_from_wire(raw: &Value, case: KeyCase) -> Result<QuerySuggestionsSetting> {
    let Value::Object(wire) = raw else {
        return Err(invalid_setting(
            "The stored query suggestions setting is not a map",
        ));
    };
    let time_zone_key = if case == KeyCase::Snake {
        "time_zone"
    } else {
        "timeZone"
    };
    let mut setting = QuerySuggestionsSetting::default();
    for (key, value) in wire.iter() {
        match key.as_str() {
            "enabled" | "fields" => {}
            "schedule" => setting.schedule = Some(text_of(value, "schedule")?),
            other if other == time_zone_key => {
                setting.time_zone = Some(text_of(value, "timeZone")?)
            }
            other => {
                if !store_number(&mut setting, other, value, case)? {
                    return Err(invalid_setting(format!(
                        "The stored query suggestions setting holds an unknown key \"{}\"",
                        other.escape_debug()
                    )));
                }
            }
        }
    }
    setting.enabled = match wire.get("enabled") {
        Some(Value::Bool(enabled)) => *enabled,
        _ => {
            return Err(invalid_setting(
                "The query suggestions setting needs a boolean \"enabled\"",
            ));
        }
    };
    setting.fields = fields_of(wire.get("fields"))?;
    validate_setting(&setting)?;
    Ok(setting)
}

/// Returns the marker of a suggestions index as the map that a file holds.
pub(crate) fn source_to_wire(source: &QuerySuggestionsSource) -> Value {
    let mut wire = Map::new();
    wire.insert("index", Value::String(source.index.clone()));
    wire.insert("group", Value::String(source.group.clone()));
    Value::Object(wire)
}

/// Reads the stored marker of a suggestions index, refusing a malformed one with `CONFIG_INVALID`.
pub(crate) fn source_from_wire(raw: &Value) -> Result<QuerySuggestionsSource> {
    let Value::Object(wire) = raw else {
        return Err(invalid_setting(
            "The suggestions index marker must be a map",
        ));
    };
    if wire.keys().any(|key| key != "index" && key != "group") {
        return Err(invalid_setting(
            "The suggestions index marker holds an unknown key",
        ));
    }
    let index = match wire.get("index") {
        Some(Value::String(index))
            if !index.is_empty()
                && index.chars().map(char::len_utf16).sum::<usize>()
                    <= MAX_SOURCE_INDEX_NAME_LENGTH =>
        {
            index.clone()
        }
        _ => {
            return Err(invalid_setting(
                "The suggestions index marker needs the name of its source index",
            ));
        }
    };
    let group = match wire.get("group") {
        Some(Value::String(group)) if is_group(group) => group.clone(),
        _ => {
            return Err(invalid_setting(
                "The suggestions index marker needs a valid group",
            ));
        }
    };
    Ok(QuerySuggestionsSource { index, group })
}
