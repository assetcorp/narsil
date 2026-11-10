mod read;
mod write;

use crate::error::{NarsilError, Result};
use crate::value::{Map, Value};

pub(crate) use read::restored_config_fields;
pub(crate) use write::{
    PayloadFacts, configuration_payload, require_configuration_within_size_limit,
    synonym_rules_payload,
};

/// Raises the error that a reader of one stored configuration raises for a malformed field.
pub(crate) type Rejection<'a> = &'a dyn Fn(&str) -> NarsilError;

pub(super) fn object<'a>(
    value: &'a Value,
    message: &str,
    reject: Rejection<'_>,
) -> Result<&'a Map> {
    value.as_object().ok_or_else(|| reject(message))
}

pub(super) fn whole_number(
    value: Option<&Value>,
    message: &str,
    reject: Rejection<'_>,
) -> Result<Option<u64>> {
    match value {
        None => Ok(None),
        Some(Value::Number(number))
            if number.fract() == 0.0 && *number >= 1.0 && *number <= 9_007_199_254_740_991.0 =>
        {
            Ok(Some(*number as u64))
        }
        Some(_) => Err(reject(message)),
    }
}

pub(super) fn string_list(value: &Value) -> Option<Vec<String>> {
    value
        .as_array()?
        .iter()
        .map(|item| item.as_str().map(str::to_string))
        .collect()
}
