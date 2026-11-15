use narsil::{ErrorCode, Map, Value, write_plain_json};

use crate::constants::MAX_SAFE_INTEGER;
use crate::errors::ServerError;

pub(crate) type Converted<T> = Result<T, ServerError>;

pub(crate) fn refusal(code: ErrorCode, message: impl Into<String>) -> ServerError {
    ServerError::coded(code.as_str(), message)
}

pub(crate) fn is_safe_integer(number: f64) -> bool {
    number.is_finite() && number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER as f64
}

pub(crate) fn safe_whole(value: &Value) -> Option<u64> {
    match value {
        Value::Number(number) if is_safe_integer(*number) && *number >= 0.0 => Some(*number as u64),
        _ => None,
    }
}

pub(crate) fn size_of(value: &Value) -> Option<usize> {
    safe_whole(value).and_then(|whole| usize::try_from(whole).ok())
}

pub(crate) fn strings_of(value: &Value) -> Option<Vec<String>> {
    let Value::Array(items) = value else {
        return None;
    };
    items
        .iter()
        .map(|item| item.as_str().map(str::to_string))
        .collect()
}

pub(crate) fn shown(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => write_plain_json(other),
    }
}

pub(crate) fn entries_of(value: &Value) -> Option<Vec<(String, &Value)>> {
    match value {
        Value::Object(map) => Some(map.iter().map(|(key, item)| (key.clone(), item)).collect()),
        Value::Array(items) => Some(
            items
                .iter()
                .enumerate()
                .map(|(at, item)| (at.to_string(), item))
                .collect(),
        ),
        _ => None,
    }
}

pub(crate) struct Fields<'a> {
    map: &'a Map,
    label: String,
}

impl<'a> Fields<'a> {
    pub(crate) fn new(map: &'a Map, label: impl Into<String>) -> Fields<'a> {
        Fields {
            map,
            label: label.into(),
        }
    }

    pub(crate) fn path(&self, key: &str) -> String {
        if self.label.is_empty() {
            key.to_string()
        } else {
            format!("{}.{key}", self.label)
        }
    }

    pub(crate) fn present(&self, key: &str) -> Option<&'a Value> {
        self.map.get(key)
    }

    pub(crate) fn get(&self, key: &str) -> Option<&'a Value> {
        self.map.get(key).filter(|value| !value.is_null())
    }

    pub(crate) fn wrong(&self, key: &str, code: ErrorCode, wanted: &str) -> ServerError {
        refusal(
            code,
            format!("Field \"{}\" must be {wanted}", self.path(key)),
        )
    }

    pub(crate) fn string(&self, key: &str, code: ErrorCode) -> Converted<Option<String>> {
        match self.get(key) {
            None => Ok(None),
            Some(Value::String(text)) => Ok(Some(text.clone())),
            Some(_) => Err(self.wrong(key, code, "a string")),
        }
    }

    pub(crate) fn boolean(&self, key: &str, code: ErrorCode) -> Converted<Option<bool>> {
        match self.get(key) {
            None => Ok(None),
            Some(Value::Bool(flag)) => Ok(Some(*flag)),
            Some(_) => Err(self.wrong(key, code, "true or false")),
        }
    }

    pub(crate) fn number(&self, key: &str, code: ErrorCode) -> Converted<Option<f64>> {
        match self.get(key) {
            None => Ok(None),
            Some(Value::Number(number)) => Ok(Some(*number)),
            Some(_) => Err(self.wrong(key, code, "a number")),
        }
    }

    pub(crate) fn size(&self, key: &str, code: ErrorCode) -> Converted<Option<usize>> {
        match self.get(key) {
            None => Ok(None),
            Some(value) => size_of(value)
                .map(Some)
                .ok_or_else(|| self.wrong(key, code, "a non-negative integer")),
        }
    }

    pub(crate) fn strings(&self, key: &str, code: ErrorCode) -> Converted<Option<Vec<String>>> {
        match self.get(key) {
            None => Ok(None),
            Some(value) => strings_of(value)
                .map(Some)
                .ok_or_else(|| self.wrong(key, code, "a list of strings")),
        }
    }

    pub(crate) fn choice<T: Copy>(
        &self,
        key: &str,
        code: ErrorCode,
        choices: &[(&str, T)],
    ) -> Converted<Option<T>> {
        let Some(value) = self.get(key) else {
            return Ok(None);
        };
        let found = value.as_str().and_then(|text| {
            choices
                .iter()
                .find(|(name, _)| *name == text)
                .map(|(_, choice)| *choice)
        });
        found.map(Some).ok_or_else(|| {
            let names: Vec<String> = choices
                .iter()
                .map(|(name, _)| format!("\"{name}\""))
                .collect();
            self.wrong(key, code, &format!("one of {}", names.join(", ")))
        })
    }
}
