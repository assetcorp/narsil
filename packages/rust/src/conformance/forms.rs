use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::envelope::{Compression, Header};
use crate::value::{Map, Value, decode_value, encode_value};

pub(crate) fn form_error(message: impl Into<String>) -> NarsilError {
    NarsilError::new(ErrorCode::CONFIG_INVALID, message.into())
}

pub(crate) fn header_form(header: &Header) -> Value {
    let mut map = Map::new();
    map.insert(
        "envelopeFormatVersion",
        Value::Number(header.envelope_format_version as f64),
    );
    map.insert(
        "compression",
        Value::String(header.compression().name().to_string()),
    );
    map.insert("checksum", Value::Bool(header.checksum_present));
    Value::Object(map)
}

pub(crate) struct HeaderForm {
    pub(crate) version: u8,
    pub(crate) compression: Compression,
    pub(crate) checksum: bool,
}

pub(crate) fn header_from_form(form: &Map) -> Result<HeaderForm> {
    let Some(Value::Object(header)) = form.get("header") else {
        return Err(form_error("the form has no header"));
    };
    let version = match header.get("envelopeFormatVersion") {
        Some(Value::Number(number)) if number.fract() == 0.0 && (0.0..=255.0).contains(number) => {
            *number as u8
        }
        _ => return Err(form_error("header.envelopeFormatVersion is not a uint8")),
    };
    let compression = match header.get("compression").and_then(Value::as_str) {
        Some("none") => Compression::None,
        Some("gzip") => Compression::Gzip,
        _ => return Err(form_error("header.compression is not none or gzip")),
    };
    let Some(Value::Bool(checksum)) = header.get("checksum") else {
        return Err(form_error("header.checksum is not a boolean"));
    };
    Ok(HeaderForm {
        version,
        compression,
        checksum: *checksum,
    })
}

pub(crate) fn object<'a>(value: Option<&'a Value>, what: &str) -> Result<&'a Map> {
    match value {
        Some(Value::Object(map)) => Ok(map),
        _ => Err(form_error(format!("{what} is not an object"))),
    }
}

pub(crate) fn list<'a>(value: Option<&'a Value>, what: &str) -> Result<&'a [Value]> {
    match value {
        Some(Value::Array(items)) => Ok(items),
        _ => Err(form_error(format!("{what} is not a list"))),
    }
}

pub(crate) fn numbers_form<T: Copy + Into<f64>>(values: &[T]) -> Value {
    Value::Array(
        values
            .iter()
            .map(|value| Value::Number((*value).into()))
            .collect(),
    )
}

pub(crate) fn u64_form(values: &[u64]) -> Value {
    Value::Array(
        values
            .iter()
            .map(|value| Value::Number(*value as f64))
            .collect(),
    )
}

fn unsigned(value: &Value, largest: f64, what: &str) -> Result<f64> {
    match value {
        Value::Number(number) if number.fract() == 0.0 && *number >= 0.0 && *number <= largest => {
            Ok(*number)
        }
        _ => Err(form_error(format!(
            "{what} holds a value outside 0 to {largest}"
        ))),
    }
}

pub(crate) fn u32_of(value: Option<&Value>, what: &str) -> Result<u32> {
    match value {
        Some(item) => unsigned(item, u32::MAX as f64, what).map(|number| number as u32),
        None => Err(form_error(format!("{what} is missing"))),
    }
}

pub(crate) fn u32s(value: Option<&Value>, what: &str) -> Result<Vec<u32>> {
    list(value, what)?
        .iter()
        .map(|item| unsigned(item, u32::MAX as f64, what).map(|number| number as u32))
        .collect()
}

pub(crate) fn u16s(value: Option<&Value>, what: &str) -> Result<Vec<u16>> {
    list(value, what)?
        .iter()
        .map(|item| unsigned(item, u16::MAX as f64, what).map(|number| number as u16))
        .collect()
}

pub(crate) fn u8s(value: Option<&Value>, what: &str) -> Result<Vec<u8>> {
    list(value, what)?
        .iter()
        .map(|item| unsigned(item, u8::MAX as f64, what).map(|number| number as u8))
        .collect()
}

pub(crate) fn u64s(value: Option<&Value>, what: &str) -> Result<Vec<u64>> {
    list(value, what)?
        .iter()
        .map(|item| unsigned(item, 9_007_199_254_740_991.0, what).map(|number| number as u64))
        .collect()
}

pub(crate) fn f64s(value: Option<&Value>, what: &str) -> Result<Vec<f64>> {
    list(value, what)?
        .iter()
        .map(|item| {
            item.as_f64()
                .ok_or_else(|| form_error(format!("{what} holds a value that is not a number")))
        })
        .collect()
}

pub(crate) fn f32s(value: Option<&Value>, what: &str) -> Result<Vec<f32>> {
    Ok(f64s(value, what)?
        .into_iter()
        .map(|number| number as f32)
        .collect())
}

pub(crate) fn string(value: Option<&Value>, what: &str) -> Result<String> {
    match value {
        Some(Value::String(text)) => Ok(text.clone()),
        _ => Err(form_error(format!("{what} is not a string"))),
    }
}

pub(crate) fn strings(value: Option<&Value>, what: &str) -> Result<Vec<String>> {
    list(value, what)?
        .iter()
        .map(|item| string(Some(item), what))
        .collect()
}

pub(crate) fn strings_form(values: &[String]) -> Value {
    Value::Array(
        values
            .iter()
            .map(|value| Value::String(value.clone()))
            .collect(),
    )
}

pub(crate) fn texts_form(blob: &[u8], offsets: &[u32]) -> Result<Value> {
    texts(blob, offsets).map(Value::Array)
}

fn table_entries<'a>(
    blob: &'a [u8],
    offsets: &'a [u32],
) -> impl Iterator<Item = Result<&'a [u8]>> + 'a {
    offsets.windows(2).map(|pair| {
        blob.get(pair[0] as usize..pair[1] as usize)
            .ok_or_else(|| form_error("an entry lies outside its table"))
    })
}

pub(crate) fn texts(blob: &[u8], offsets: &[u32]) -> Result<Vec<Value>> {
    table_entries(blob, offsets)
        .map(|bytes| {
            let text = std::str::from_utf8(bytes?)
                .map_err(|_| form_error("an entry is not valid UTF-8"))?;
            Ok(Value::String(text.to_string()))
        })
        .collect()
}

pub(crate) fn joined(parts: impl IntoIterator<Item = Vec<u8>>) -> (Vec<u8>, Vec<u32>) {
    let mut blob = Vec::new();
    let mut offsets = vec![0u32];
    for part in parts {
        blob.extend_from_slice(&part);
        offsets.push(blob.len() as u32);
    }
    (blob, offsets)
}

pub(crate) fn texts_from_form(value: Option<&Value>, what: &str) -> Result<(Vec<u8>, Vec<u32>)> {
    let texts = strings(value, what)?;
    Ok(joined(texts.into_iter().map(String::into_bytes)))
}

pub(crate) fn packed_form(blob: &[u8], offsets: &[u32]) -> Result<Value> {
    table_entries(blob, offsets)
        .map(|bytes| decode_value(bytes?))
        .collect::<Result<Vec<Value>>>()
        .map(Value::Array)
}

pub(crate) fn packed_from_form(value: Option<&Value>, what: &str) -> Result<(Vec<u8>, Vec<u32>)> {
    let items = list(value, what)?;
    let mut parts = Vec::with_capacity(items.len());
    for item in items {
        parts.push(encode_value(item)?);
    }
    Ok(joined(parts))
}
