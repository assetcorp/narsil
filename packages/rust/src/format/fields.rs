use crate::error::{ErrorCode, NarsilError, Result};
use crate::value::{Map, Value};

/// Reads the fields of one decoded payload map, raising one error code for every malformed field.
pub(crate) struct Fields<'a> {
    map: &'a Map,
    code: ErrorCode,
    prefix: &'a str,
}

const MAX_UINT32: f64 = 4_294_967_295.0;

impl<'a> Fields<'a> {
    pub(crate) fn new(map: &'a Map, code: ErrorCode, prefix: &'a str) -> Fields<'a> {
        Fields { map, code, prefix }
    }

    pub(crate) fn error(&self, message: impl AsRef<str>) -> NarsilError {
        NarsilError::new(self.code, format!("{}{}", self.prefix, message.as_ref()))
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
            Some(Value::Bytes(bytes)) => Err(self.error(format!(
                "{name} holds {} bytes, which is not a whole number of {width}-byte values",
                bytes.len()
            ))),
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
            Value::Object(map) => Ok(Fields::new(map, self.code, self.prefix)),
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
        match self.map.get(key) {
            Some(Value::Number(number))
                if number.fract() == 0.0 && (0.0..=MAX_UINT32).contains(number) =>
            {
                Ok(*number as u32)
            }
            _ => Err(self.error(format!("{key} must be a uint32"))),
        }
    }

    pub(crate) fn require_count(&self, found: usize, expected: usize, name: &str) -> Result<()> {
        if found == expected {
            return Ok(());
        }
        Err(self.error(format!(
            "{name} holds {found} values where the segment needs {expected}"
        )))
    }
}
