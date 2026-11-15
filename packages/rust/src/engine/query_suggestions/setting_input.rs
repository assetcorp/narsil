use super::constants as limits;
use super::schedule::{parse_schedule, time_zone_named};
use super::setting::{Bound, RANGES, require_products, validate_setting};
use super::types::QuerySuggestionsSetting;
use crate::error::Result;
use crate::format::fields::whole_number;
use crate::format::metadata_parts::config_invalid;
use crate::value::{MAX_SAFE_INTEGER, Map, Value};

const TEXT_KEYS: [&str; 4] = ["enabled", "fields", "schedule", "timeZone"];

fn known_key(key: &str) -> bool {
    TEXT_KEYS.contains(&key) || RANGES.iter().any(|range| range.key == key)
}

fn fields_of(input: &Map) -> Result<Vec<String>> {
    let wanted = || {
        config_invalid(format!(
            "The query suggestions setting needs from 1 to {} fields",
            limits::MAX_FIELDS
        ))
    };
    let Some(Value::Array(items)) = input.get("fields") else {
        return Err(wanted());
    };
    if items.is_empty() || items.len() > limits::MAX_FIELDS {
        return Err(wanted());
    }
    let mut fields: Vec<String> = Vec::with_capacity(items.len());
    for item in items {
        match item {
            Value::String(field) if !field.is_empty() && !fields.contains(field) => {
                fields.push(field.clone());
            }
            _ => {
                return Err(config_invalid(
                    "Each field of the query suggestions setting must be a distinct, non-empty path",
                ));
            }
        }
    }
    Ok(fields)
}

fn given_numbers(input: &Map) -> Result<Vec<Option<f64>>> {
    RANGES
        .iter()
        .map(|range| match input.get(range.key) {
            None => Ok(None),
            given => whole_number(given)
                .filter(|number| number.abs() <= MAX_SAFE_INTEGER as f64)
                .map(Some)
                .ok_or_else(|| config_invalid(format!("{} must be a whole number", range.key))),
        })
        .collect()
}

fn apply_ranges(setting: &mut QuerySuggestionsSetting, given: &[Option<f64>]) -> Result<()> {
    let resolved: Vec<f64> = RANGES
        .iter()
        .zip(given)
        .map(|(range, number)| number.unwrap_or(range.fallback as f64))
        .collect();
    let max_length = RANGES
        .iter()
        .zip(&resolved)
        .find(|(range, _)| range.key == "maxLength")
        .map_or(limits::DEFAULT_MAX_LENGTH as f64, |(_, value)| *value);
    for ((range, value), number) in RANGES.iter().zip(&resolved).zip(given) {
        let max = match range.max {
            Bound::Fixed(max) => max as f64,
            Bound::MaxLength => max_length,
        };
        if *value < range.min as f64 || *value > max {
            return Err(config_invalid(format!(
                "{} must be from {} to {max}",
                range.key, range.min
            )));
        }
        if let Some(number) = number {
            (range.set)(setting, *number as u64).ok_or_else(|| {
                config_invalid(format!("{} must be from {} to {max}", range.key, range.min))
            })?;
        }
    }
    Ok(())
}

fn schedule_of(input: &Map) -> Result<Option<String>> {
    match input.get("schedule") {
        None => Ok(None),
        Some(Value::String(schedule)) => {
            if schedule != limits::SCHEDULE_OFF && parse_schedule(schedule).is_none() {
                return Err(config_invalid(
                    "schedule must be \"off\" or a cron expression of five fields",
                ));
            }
            Ok(Some(schedule.clone()))
        }
        Some(_) => Err(config_invalid("schedule must be a string")),
    }
}

fn time_zone_of(input: &Map) -> Result<Option<String>> {
    match input.get("timeZone") {
        None => Ok(None),
        Some(Value::String(time_zone)) if time_zone_named(time_zone).is_some() => {
            Ok(Some(time_zone.clone()))
        }
        Some(_) => Err(config_invalid("timeZone must name an IANA time zone")),
    }
}

impl QuerySuggestionsSetting {
    /// Returns the setting that a caller sent as a camelCase JSON object, checking it in the order and with the
    /// messages that every Narsil server uses.
    ///
    /// The checks run in this order: the shape of the object, unknown keys, `enabled`, `fields`, the type of each
    /// limit, the range of each limit, the products of the limits, `schedule`, `timeZone`, and the encoded size.
    /// The first check to fail decides the error.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` when `input` breaks any rule of the setting.
    pub fn from_input(input: &Value) -> Result<QuerySuggestionsSetting> {
        let Value::Object(input) = input else {
            return Err(config_invalid(
                "The query suggestions setting must be an object",
            ));
        };
        if let Some(key) = input.keys().find(|key| !known_key(key)) {
            return Err(config_invalid(format!(
                "The query suggestions setting holds an unknown key \"{key}\""
            )));
        }
        let Some(Value::Bool(enabled)) = input.get("enabled") else {
            return Err(config_invalid(
                "The query suggestions setting needs a boolean \"enabled\"",
            ));
        };
        let mut setting = QuerySuggestionsSetting {
            enabled: *enabled,
            fields: fields_of(input)?,
            ..QuerySuggestionsSetting::default()
        };
        let given = given_numbers(input)?;
        apply_ranges(&mut setting, &given)?;
        require_products(&setting.resolve())?;
        setting.schedule = schedule_of(input)?;
        setting.time_zone = time_zone_of(input)?;
        validate_setting(&setting)?;
        Ok(setting)
    }
}
