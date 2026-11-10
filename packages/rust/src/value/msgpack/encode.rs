use super::{MAX_ENCODING_DEPTH, TIMESTAMP_EXTENSION};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::value::{Map, Timestamp, Value};

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const TIMESTAMP_32_SECONDS_LIMIT: i64 = 0x1_0000_0000;
const TIMESTAMP_64_SECONDS_LIMIT: i64 = 0x4_0000_0000;

pub(crate) fn write_nil(out: &mut Vec<u8>) {
    out.push(0xc0);
}

pub(crate) fn write_uint(out: &mut Vec<u8>, number: u64) {
    if number < 0x80 {
        out.push(number as u8);
    } else if number < 0x100 {
        out.extend_from_slice(&[0xcc, number as u8]);
    } else if number < 0x1_0000 {
        out.push(0xcd);
        out.extend_from_slice(&(number as u16).to_be_bytes());
    } else if number < 0x1_0000_0000 {
        out.push(0xce);
        out.extend_from_slice(&(number as u32).to_be_bytes());
    } else {
        out.push(0xcf);
        out.extend_from_slice(&number.to_be_bytes());
    }
}

fn write_int(out: &mut Vec<u8>, number: i64) {
    if number >= 0 {
        write_uint(out, number as u64);
    } else if number >= -0x20 {
        out.push(number as i8 as u8);
    } else if number >= -0x80 {
        out.extend_from_slice(&[0xd0, number as i8 as u8]);
    } else if number >= -0x8000 {
        out.push(0xd1);
        out.extend_from_slice(&(number as i16).to_be_bytes());
    } else if number >= -0x8000_0000 {
        out.push(0xd2);
        out.extend_from_slice(&(number as i32).to_be_bytes());
    } else {
        out.push(0xd3);
        out.extend_from_slice(&number.to_be_bytes());
    }
}

pub(crate) fn write_number(out: &mut Vec<u8>, number: f64) {
    let integral = number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER;
    if integral && !(number == 0.0 && number.is_sign_negative()) {
        write_int(out, number as i64);
    } else {
        out.push(0xcb);
        out.extend_from_slice(&number.to_bits().to_be_bytes());
    }
}

fn write_length(out: &mut Vec<u8>, length: usize, fix_base: Option<(u8, usize)>, codes: [u8; 3]) {
    match fix_base {
        Some((base, limit)) if length < limit => out.push(base | length as u8),
        _ if codes[0] != 0 && length < 0x100 => out.extend_from_slice(&[codes[0], length as u8]),
        _ if length < 0x1_0000 => {
            out.push(codes[1]);
            out.extend_from_slice(&(length as u16).to_be_bytes());
        }
        _ => {
            out.push(codes[2]);
            out.extend_from_slice(&(length as u32).to_be_bytes());
        }
    }
}

pub(crate) fn write_string(out: &mut Vec<u8>, text: &str) {
    write_length(out, text.len(), Some((0xa0, 32)), [0xd9, 0xda, 0xdb]);
    out.extend_from_slice(text.as_bytes());
}

pub(crate) fn write_binary(out: &mut Vec<u8>, bytes: &[u8]) {
    write_length(out, bytes.len(), None, [0xc4, 0xc5, 0xc6]);
    out.extend_from_slice(bytes);
}

pub(crate) fn write_array_header(out: &mut Vec<u8>, length: usize) {
    write_length(out, length, Some((0x90, 16)), [0, 0xdc, 0xdd]);
}

pub(crate) fn write_map_header(out: &mut Vec<u8>, length: usize) {
    write_length(out, length, Some((0x80, 16)), [0, 0xde, 0xdf]);
}

fn write_timestamp(out: &mut Vec<u8>, timestamp: Timestamp) {
    let Timestamp {
        seconds,
        nanoseconds,
    } = timestamp;
    if (0..TIMESTAMP_32_SECONDS_LIMIT).contains(&seconds) && nanoseconds == 0 {
        out.extend_from_slice(&[0xd6, TIMESTAMP_EXTENSION as u8]);
        out.extend_from_slice(&(seconds as u32).to_be_bytes());
    } else if (0..TIMESTAMP_64_SECONDS_LIMIT).contains(&seconds) {
        out.extend_from_slice(&[0xd7, TIMESTAMP_EXTENSION as u8]);
        out.extend_from_slice(&(((nanoseconds as u64) << 34) | seconds as u64).to_be_bytes());
    } else {
        out.extend_from_slice(&[0xc7, 12, TIMESTAMP_EXTENSION as u8]);
        out.extend_from_slice(&nanoseconds.to_be_bytes());
        out.extend_from_slice(&seconds.to_be_bytes());
    }
}

fn encode_into(out: &mut Vec<u8>, value: &Value, depth: usize) -> Result<()> {
    if depth > MAX_ENCODING_DEPTH {
        return Err(NarsilError::new(
            ErrorCode::DOC_VALIDATION_FAILED,
            format!(
                "The value nests deeper than {MAX_ENCODING_DEPTH} levels, so MessagePack cannot encode it"
            ),
        ));
    }
    match value {
        Value::Null => write_nil(out),
        Value::Bool(flag) => out.push(if *flag { 0xc3 } else { 0xc2 }),
        Value::Number(number) => write_number(out, *number),
        Value::String(text) => write_string(out, text),
        Value::Bytes(bytes) => write_binary(out, bytes),
        Value::Timestamp(timestamp) => write_timestamp(out, *timestamp),
        Value::Array(items) => {
            write_array_header(out, items.len());
            for item in items {
                encode_into(out, item, depth + 1)?;
            }
        }
        Value::Object(map) => {
            write_map_header(out, map.len());
            for (key, entry) in map.iter() {
                write_string(out, key);
                encode_into(out, entry, depth + 1)?;
            }
        }
    }
    Ok(())
}

pub(crate) fn encode_value(value: &Value) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    encode_into(&mut out, value, 1)?;
    Ok(out)
}

pub(crate) fn encode_document(document: &Map) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(64);
    write_map_header(&mut out, document.len());
    for (key, entry) in document.iter() {
        write_string(&mut out, key);
        encode_into(&mut out, entry, 2)?;
    }
    Ok(out)
}
