use narsil::{Map, Value};

use super::payload::invalid;
use crate::error::{ClusterError, ClusterResult, codes};

pub(super) const SEARCH_PAYLOAD: &str = "SearchPayload";

pub(super) fn wrong(code: &str, label: &str, rule: &str) -> ClusterError {
    invalid(
        code,
        format!("Invalid {SEARCH_PAYLOAD}: \"params.{label}\" {rule}"),
    )
}

pub(super) fn number(value: Option<&Value>, label: &str) -> ClusterResult<Option<f64>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) if number.is_finite() => Ok(Some(*number)),
        Some(_) => Err(wrong(
            codes::CONFIG_INVALID,
            label,
            "must be a finite number or null",
        )),
    }
}

pub(super) fn whole(
    value: Option<&Value>,
    label: &str,
    max_value: f64,
) -> ClusterResult<Option<u64>> {
    match number(value, label)? {
        None => Ok(None),
        Some(number) if number.fract() == 0.0 && (0.0..=max_value).contains(&number) => {
            Ok(Some(number as u64))
        }
        Some(_) => Err(wrong(
            codes::CONFIG_INVALID,
            label,
            &format!("must be a non-negative integer at most {max_value}"),
        )),
    }
}

pub(super) fn flag(value: Option<&Value>, label: &str) -> ClusterResult<Option<bool>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(flag)) => Ok(Some(*flag)),
        Some(_) => Err(wrong(
            codes::CONFIG_INVALID,
            label,
            "must be a boolean or null",
        )),
    }
}

pub(super) fn text<'a>(value: Option<&'a Value>, label: &str) -> ClusterResult<Option<&'a str>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text)),
        Some(_) => Err(wrong(
            codes::CONFIG_INVALID,
            label,
            "must be a string or null",
        )),
    }
}

pub(super) fn object<'a>(value: Option<&'a Value>, label: &str) -> ClusterResult<Option<&'a Map>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(fields)) => Ok(Some(fields)),
        Some(_) => Err(wrong(
            codes::CONFIG_INVALID,
            label,
            "must be an object or null",
        )),
    }
}
