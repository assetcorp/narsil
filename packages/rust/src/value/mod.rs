mod json;
mod map;
mod msgpack;
mod number_text;

pub use json::{parse_json, write_json};
pub(crate) use json::{parse_json_raw, untag_value, write_exact_json_into, write_json_into};
pub use map::Map;
pub(crate) use msgpack::{
    Decoder, MAX_ENCODING_DEPTH, decode_document, decode_value, encode_document, encode_value,
    write_array_header, write_binary, write_map_header, write_nil, write_number, write_string,
    write_uint,
};
pub(crate) use number_text::number_to_text;

/// A MessagePack timestamp: whole seconds since the Unix epoch, and the nanoseconds past them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Timestamp {
    /// Whole seconds since 1970-01-01T00:00:00Z, negative before it.
    pub seconds: i64,
    /// Nanoseconds past `seconds`, from 0 to 999,999,999.
    pub nanoseconds: u32,
}

/// One value of a document, of a query, or of a stored file.
///
/// A number is a float64, as it is in every Narsil implementation, so `1` and `1.0` are one value. A document is
/// an [`Value::Object`] whose fields follow the schema of its index.
#[derive(Debug, Clone, PartialEq, Default)]
pub enum Value {
    /// The MessagePack nil and the JSON `null`.
    #[default]
    Null,
    /// A boolean.
    Bool(bool),
    /// A number, held as a float64.
    Number(f64),
    /// A string of Unicode scalar values.
    String(String),
    /// Raw bytes, which MessagePack stores as a binary value.
    Bytes(Vec<u8>),
    /// A point in time, which MessagePack stores as its timestamp extension.
    Timestamp(Timestamp),
    /// A list of values.
    Array(Vec<Value>),
    /// A map of field names to values.
    Object(Map),
}

impl Value {
    /// Returns the string that this value holds, or `None` for any other kind of value.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(text) => Some(text),
            _ => None,
        }
    }

    /// Returns the number that this value holds, or `None` for any other kind of value.
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::Number(number) => Some(*number),
            _ => None,
        }
    }

    /// Returns the boolean that this value holds, or `None` for any other kind of value.
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(flag) => Some(*flag),
            _ => None,
        }
    }

    /// Returns the list that this value holds, or `None` for any other kind of value.
    pub fn as_array(&self) -> Option<&Vec<Value>> {
        match self {
            Value::Array(items) => Some(items),
            _ => None,
        }
    }

    /// Returns the map that this value holds, or `None` for any other kind of value.
    pub fn as_object(&self) -> Option<&Map> {
        match self {
            Value::Object(map) => Some(map),
            _ => None,
        }
    }

    /// Returns the map that this value holds, mutably, or `None` for any other kind of value.
    pub fn as_object_mut(&mut self) -> Option<&mut Map> {
        match self {
            Value::Object(map) => Some(map),
            _ => None,
        }
    }

    /// Returns true for [`Value::Null`].
    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }

    /// Returns the value at a dotted `path` inside nested objects, such as `"meta.author"`.
    pub fn pointer(&self, path: &str) -> Option<&Value> {
        let mut current = self;
        for segment in path.split('.') {
            current = current.as_object()?.get(segment)?;
        }
        Some(current)
    }

    /// Parses JSON text, reading each `$date`, `$bytes`, `$number`, and `$object` tag as the value that it stands for.
    pub fn from_json(text: &str) -> crate::Result<Value> {
        parse_json(text)
    }

    /// Writes this value as JSON text, with a tag for each value that JSON has no type for.
    pub fn to_json(&self) -> String {
        write_json(self)
    }
}

impl From<bool> for Value {
    fn from(flag: bool) -> Value {
        Value::Bool(flag)
    }
}

macro_rules! number_from {
    ($($kind:ty),*) => {
        $(impl From<$kind> for Value {
            fn from(number: $kind) -> Value {
                Value::Number(number as f64)
            }
        })*
    };
}

number_from!(f64, f32, i8, i16, i32, i64, u8, u16, u32, u64, usize, isize);

impl From<&str> for Value {
    fn from(text: &str) -> Value {
        Value::String(text.to_string())
    }
}

impl From<String> for Value {
    fn from(text: String) -> Value {
        Value::String(text)
    }
}

impl From<Map> for Value {
    fn from(map: Map) -> Value {
        Value::Object(map)
    }
}

impl From<Timestamp> for Value {
    fn from(timestamp: Timestamp) -> Value {
        Value::Timestamp(timestamp)
    }
}

impl<T: Into<Value>> From<Vec<T>> for Value {
    fn from(items: Vec<T>) -> Value {
        Value::Array(items.into_iter().map(Into::into).collect())
    }
}

impl<T: Into<Value>> From<Option<T>> for Value {
    fn from(option: Option<T>) -> Value {
        option.map_or(Value::Null, Into::into)
    }
}

/// Builds an object [`Value`] from `key => value` pairs, converting each value with `Into<Value>`.
///
/// ```
/// let document = narsil::object! { "title" => "Dune", "year" => 1965 };
/// assert_eq!(document.pointer("year").and_then(|year| year.as_f64()), Some(1965.0));
/// ```
#[macro_export]
macro_rules! object {
    () => { $crate::Value::Object($crate::Map::new()) };
    ($($key:expr => $value:expr),+ $(,)?) => {{
        let mut map = $crate::Map::new();
        $(map.insert($key, $crate::Value::from($value));)+
        $crate::Value::Object(map)
    }};
}
