use std::borrow::Cow;

use super::source::{SortValue, reduced_min};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::value::{Decoder, MAX_ENCODING_DEPTH, Value, number_to_text};

fn malformed_key() -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_LOAD_FAILED,
        "The MessagePack data is malformed: a map key is neither a string nor a number",
    )
}

fn is_string_marker(marker: u8) -> bool {
    matches!(marker, 0xa0..=0xbf | 0xd9..=0xdb)
}

fn is_number_marker(marker: u8) -> bool {
    matches!(marker, 0x00..=0x7f | 0xe0..=0xff | 0xca..=0xd3)
}

fn is_array_marker(marker: u8) -> bool {
    matches!(marker, 0x90..=0x9f | 0xdc | 0xdd)
}

fn is_map_marker(marker: u8) -> bool {
    matches!(marker, 0x80..=0x8f | 0xde | 0xdf)
}

fn skip_value(decoder: &mut Decoder<'_>, depth: usize) -> Result<()> {
    if depth > MAX_ENCODING_DEPTH {
        return decoder.read_value(depth).map(|_| ());
    }
    let marker = decoder.peek()?;
    match marker {
        0xc0 => decoder.read_nil().map(|_| ()),
        0xc2 | 0xc3 => decoder.read_bool().map(|_| ()),
        _ if is_number_marker(marker) => decoder.read_number().map(|_| ()),
        _ if is_string_marker(marker) => decoder.read_str().map(|_| ()),
        0xc4..=0xc6 => decoder.read_bin().map(|_| ()),
        _ if is_array_marker(marker) => {
            for _ in 0..decoder.read_array_length()? {
                skip_value(decoder, depth + 1)?;
            }
            Ok(())
        }
        _ if is_map_marker(marker) => {
            for _ in 0..decoder.read_map_length()? {
                skip_key(decoder)?;
                skip_value(decoder, depth + 1)?;
            }
            Ok(())
        }
        _ => decoder.read_value(depth).map(|_| ()),
    }
}

fn skip_key(decoder: &mut Decoder<'_>) -> Result<()> {
    let marker = decoder.peek()?;
    if is_string_marker(marker) {
        return decoder.read_str().map(|_| ());
    }
    if is_number_marker(marker) {
        return decoder.read_number().map(|_| ());
    }
    Err(malformed_key())
}

fn key_matches(decoder: &mut Decoder<'_>, wanted: &str) -> Result<bool> {
    let marker = decoder.peek()?;
    if is_string_marker(marker) {
        return Ok(decoder.read_str()? == wanted);
    }
    if is_number_marker(marker) {
        return Ok(number_to_text(decoder.read_number()?) == wanted);
    }
    Err(malformed_key())
}

pub(crate) fn stored_field<'a>(bytes: &'a [u8], path: &str) -> Result<Option<&'a [u8]>> {
    let mut current = bytes;
    for segment in path.split('.') {
        let mut decoder = Decoder::new(current);
        if !is_map_marker(decoder.peek()?) {
            return Ok(None);
        }
        let mut found = None;
        for _ in 0..decoder.read_map_length()? {
            let matched = key_matches(&mut decoder, segment)?;
            let start = decoder.position();
            skip_value(&mut decoder, 2)?;
            if matched {
                found = current.get(start..decoder.position());
            }
        }
        let Some(value) = found else {
            return Ok(None);
        };
        current = value;
    }
    Ok(Some(current))
}

pub(crate) fn visit_stored_texts(
    value: &[u8],
    visit: &mut dyn FnMut(&str) -> Result<bool>,
) -> Result<()> {
    let mut decoder = Decoder::new(value);
    let marker = decoder.peek()?;
    if is_string_marker(marker) {
        visit(decoder.read_str()?)?;
        return Ok(());
    }
    if !is_array_marker(marker) {
        return Ok(());
    }
    for _ in 0..decoder.read_array_length()? {
        if is_string_marker(decoder.peek()?) {
            if !visit(decoder.read_str()?)? {
                return Ok(());
            }
        } else {
            skip_value(&mut decoder, 2)?;
        }
    }
    Ok(())
}

fn scalar_sort_value<'a>(decoder: &mut Decoder<'a>) -> Result<Option<SortValue<'a>>> {
    let marker = decoder.peek()?;
    Ok(match marker {
        0xc2 | 0xc3 => Some(SortValue::Boolean(decoder.read_bool()?)),
        _ if is_number_marker(marker) => Some(SortValue::Number(decoder.read_number()?)),
        _ if is_string_marker(marker) => Some(SortValue::Text(Cow::Borrowed(decoder.read_str()?))),
        _ => {
            skip_value(decoder, 2)?;
            None
        }
    })
}

pub(crate) fn stored_min_sort_value(value: &[u8]) -> Result<Option<SortValue<'_>>> {
    let mut decoder = Decoder::new(value);
    if !is_array_marker(decoder.peek()?) {
        return Ok(scalar_sort_value(&mut decoder)?.and_then(|value| reduced_min(None, value)));
    }
    let mut chosen = None;
    for _ in 0..decoder.read_array_length()? {
        if let Some(candidate) = scalar_sort_value(&mut decoder)? {
            chosen = reduced_min(chosen, candidate);
        }
    }
    Ok(chosen)
}

pub(crate) fn visit_value_texts(
    value: &Value,
    visit: &mut dyn FnMut(&str) -> Result<bool>,
) -> Result<()> {
    match value {
        Value::String(text) => {
            visit(text)?;
        }
        Value::Array(items) => {
            for item in items {
                if let Value::String(text) = item {
                    if !visit(text)? {
                        break;
                    }
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn value_sort_scalar(value: &Value) -> Option<SortValue<'_>> {
    match value {
        Value::Bool(flag) => Some(SortValue::Boolean(*flag)),
        Value::Number(number) => Some(SortValue::Number(*number)),
        Value::String(text) => Some(SortValue::Text(Cow::Borrowed(text))),
        _ => None,
    }
}

pub(crate) fn value_min_sort_value(value: &Value) -> Option<SortValue<'_>> {
    match value {
        Value::Array(items) => items
            .iter()
            .filter_map(value_sort_scalar)
            .fold(None, reduced_min),
        other => value_sort_scalar(other).and_then(|value| reduced_min(None, value)),
    }
}
