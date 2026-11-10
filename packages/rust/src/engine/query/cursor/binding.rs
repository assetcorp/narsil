use crate::util::hash::fnv1a;
use crate::value::{Map, Value};

pub(super) const ABSENT_TAG: u8 = 0;
const NULL_TAG: u8 = 1;
pub(super) const FALSE_TAG: u8 = 2;
pub(super) const TRUE_TAG: u8 = 3;
const NUMBER_TAG: u8 = 4;
const STRING_TAG: u8 = 5;
pub(super) const LIST_TAG: u8 = 6;
pub(super) const MAP_TAG: u8 = 7;
const FILTERS_SLOT: usize = 2;
const BOUND_SLOT_COUNT: usize = 16;
const CANONICAL_NAN_BITS: u64 = 0x7ff8_0000_0000_0000;

pub(super) fn write_length(stream: &mut Vec<u8>, length: usize) {
    stream.extend_from_slice(&(length as u32).to_be_bytes());
}

pub(super) fn write_string(stream: &mut Vec<u8>, text: &str) {
    stream.push(STRING_TAG);
    write_length(stream, text.len());
    stream.extend_from_slice(text.as_bytes());
}

pub(super) fn write_number(stream: &mut Vec<u8>, number: f64) {
    let bits = if number.is_nan() {
        CANONICAL_NAN_BITS
    } else {
        number.to_bits()
    };
    stream.push(NUMBER_TAG);
    stream.extend_from_slice(&bits.to_be_bytes());
}

fn write_map(stream: &mut Vec<u8>, map: &Map) {
    let mut keys: Vec<&String> = map.keys().collect();
    keys.sort_unstable();
    stream.push(MAP_TAG);
    write_length(stream, keys.len());
    for key in keys {
        write_string(stream, key);
        match map.get(key) {
            Some(value) => write_value(stream, value),
            None => stream.push(NULL_TAG),
        }
    }
}

fn write_bytes_as_record(stream: &mut Vec<u8>, bytes: &[u8]) {
    let mut keys: Vec<(String, u8)> = bytes
        .iter()
        .enumerate()
        .map(|(at, byte)| (at.to_string(), *byte))
        .collect();
    keys.sort_unstable();
    stream.push(MAP_TAG);
    write_length(stream, keys.len());
    for (key, byte) in keys {
        write_string(stream, &key);
        write_number(stream, f64::from(byte));
    }
}

pub(super) fn write_value(stream: &mut Vec<u8>, value: &Value) {
    match value {
        Value::Null => stream.push(NULL_TAG),
        Value::Bool(false) => stream.push(FALSE_TAG),
        Value::Bool(true) => stream.push(TRUE_TAG),
        Value::Number(number) => write_number(stream, *number),
        Value::String(text) => write_string(stream, text),
        Value::Array(items) => {
            stream.push(LIST_TAG);
            write_length(stream, items.len());
            for item in items {
                write_value(stream, item);
            }
        }
        Value::Object(map) => write_map(stream, map),
        Value::Bytes(bytes) => write_bytes_as_record(stream, bytes),
        Value::Timestamp(_) => {
            stream.push(MAP_TAG);
            write_length(stream, 0);
        }
    }
}

/// Returns the cursor binding of a listing, the FNV-1a hash of a binding stream that holds its filter in the
/// filter slot and every other bound value absent, as eight lowercase hex digits.
///
/// A raw-bytes value binds as the reference engine binds a `Uint8Array`, a record keyed by each byte's index, and a
/// timestamp binds as it binds a `Date`, a record with no keys.
pub(crate) fn list_binding(filters: Option<&Value>) -> String {
    let mut stream = Vec::new();
    for slot in 0..BOUND_SLOT_COUNT {
        match filters {
            Some(filters) if slot == FILTERS_SLOT => write_value(&mut stream, filters),
            _ => stream.push(ABSENT_TAG),
        }
    }
    format!("{:08x}", fnv1a(&stream))
}
