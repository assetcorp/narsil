use crate::error::{ErrorCode, NarsilError, Result};
use crate::value::{MAX_SAFE_INTEGER, Map, Value};

/// Reads the fields of one decoded payload map, raising one error code for every malformed field.
pub(crate) struct Fields<'a> {
    map: &'a Map,
    code: ErrorCode,
    prefix: &'a str,
    names_fields: bool,
}

const MAX_UINT32: f64 = 4_294_967_295.0;

pub(crate) fn whole_number(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) if number.is_finite() && number.fract() == 0.0 => Some(*number),
        _ => None,
    }
}

pub(crate) fn whole_number_up_to(value: Option<&Value>, highest: f64) -> Option<f64> {
    whole_number(value).filter(|number| (0.0..=highest).contains(number))
}

pub(crate) fn non_negative_safe_integer(value: Option<&Value>) -> Option<u64> {
    whole_number_up_to(value, MAX_SAFE_INTEGER as f64).map(|number| number as u64)
}

pub(crate) fn uint32_of(value: Option<&Value>) -> Option<u32> {
    whole_number_up_to(value, MAX_UINT32).map(|number| number as u32)
}

pub(crate) fn string_list(value: Option<&Value>) -> Option<Vec<String>> {
    let Some(Value::Array(items)) = value else {
        return None;
    };
    items
        .iter()
        .map(|item| item.as_str().map(str::to_string))
        .collect()
}

impl<'a> Fields<'a> {
    pub(crate) fn new(map: &'a Map, code: ErrorCode, prefix: &'a str) -> Fields<'a> {
        Fields {
            map,
            code,
            prefix,
            names_fields: false,
        }
    }

    pub(crate) fn naming_fields(self) -> Fields<'a> {
        Fields {
            names_fields: true,
            ..self
        }
    }

    pub(crate) fn error(&self, message: impl AsRef<str>) -> NarsilError {
        NarsilError::new(self.code, format!("{}{}", self.prefix, message.as_ref()))
    }

    pub(crate) fn field_error<K: Into<String>>(
        &self,
        message: impl AsRef<str>,
        details: impl IntoIterator<Item = (K, Value)>,
    ) -> NarsilError {
        let error = self.error(message);
        if self.names_fields {
            error.with_details(details)
        } else {
            error
        }
    }

    pub(crate) fn raw(&self, key: &str) -> Option<&'a Value> {
        self.map.get(key)
    }

    pub(crate) fn has_key(&self, key: &str) -> bool {
        self.map.contains_key(key)
    }

    pub(crate) fn bytes(&self, key: &str, width: usize) -> Result<&'a [u8]> {
        self.bytes_as(key, key, width)
    }

    pub(crate) fn bytes_as(&self, key: &str, name: &str, width: usize) -> Result<&'a [u8]> {
        match self.map.get(key) {
            Some(Value::Bytes(bytes)) if bytes.len() % width == 0 => Ok(bytes),
            Some(Value::Bytes(bytes)) => Err(self.field_error(
                format!(
                    "{name} holds {} bytes, which is not a whole number of {width}-byte values",
                    bytes.len()
                ),
                [("field", Value::from(name))],
            )),
            _ => Err(self.error(format!("{name} must be bytes"))),
        }
    }

    pub(crate) fn string_as(&self, key: &str, name: &str) -> Result<&'a str> {
        match self.map.get(key) {
            Some(Value::String(text)) => Ok(text),
            _ => Err(self.error(format!("{name} must be a string"))),
        }
    }

    pub(crate) fn strings_as(&self, key: &str, name: &str) -> Result<Vec<String>> {
        let Some(Value::Array(items)) = self.map.get(key) else {
            return Err(self.error(format!("{name} must be a list")));
        };
        items
            .iter()
            .map(|item| match item {
                Value::String(text) => Ok(text.clone()),
                _ => Err(self.error(format!("{name} must hold strings alone"))),
            })
            .collect()
    }

    pub(crate) fn nested(&self, value: &'a Value, name: &str) -> Result<Fields<'a>> {
        match value {
            Value::Object(map) => Ok(Fields {
                map,
                code: self.code,
                prefix: self.prefix,
                names_fields: self.names_fields,
            }),
            _ => Err(self.error(format!("{name} must be a map"))),
        }
    }

    pub(crate) fn bytes_or_nil(&self, key: &str, width: usize) -> Result<Option<&'a [u8]>> {
        match self.map.get(key) {
            None | Some(Value::Null) => Ok(None),
            _ => self.bytes(key, width).map(Some),
        }
    }

    pub(crate) fn string(&self, key: &str) -> Result<&'a str> {
        match self.map.get(key) {
            Some(Value::String(text)) => Ok(text),
            _ => Err(self.error(format!("{key} must be a string"))),
        }
    }

    pub(crate) fn list(&self, key: &str) -> Result<&'a [Value]> {
        match self.map.get(key) {
            Some(Value::Array(items)) => Ok(items),
            _ => Err(self.error(format!("{key} must be a list"))),
        }
    }

    pub(crate) fn strings(&self, key: &str) -> Result<Vec<String>> {
        let items = self.list(key)?;
        items
            .iter()
            .map(|item| match item {
                Value::String(text) => Ok(text.clone()),
                _ => Err(self.error(format!("{key} must hold strings alone"))),
            })
            .collect()
    }

    pub(crate) fn uint32(&self, key: &str) -> Result<u32> {
        uint32_of(self.map.get(key)).ok_or_else(|| self.error(format!("{key} must be a uint32")))
    }

    pub(crate) fn require_count(&self, found: usize, expected: usize, name: &str) -> Result<()> {
        if found == expected {
            return Ok(());
        }
        Err(self.field_error(
            format!("{name} holds {found} values where the segment needs {expected}"),
            [
                ("field", Value::from(name)),
                ("found", Value::from(found)),
                ("expected", Value::from(expected)),
            ],
        ))
    }
}
