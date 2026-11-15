mod decode;
mod encode;

pub(crate) use decode::{Decoder, decode_document, decode_value};
pub(crate) use encode::{
    encode_document, encode_value, write_array_header, write_binary, write_map_header, write_nil,
    write_number, write_string, write_uint,
};

pub(crate) const MAX_ENCODING_DEPTH: usize = 100;
const TIMESTAMP_EXTENSION: i8 = -1;

/// Returns the MessagePack encoding of `value`, with each number in its shortest exact form and each map in its
/// key order, as the engine writes a stored document.
///
/// # Errors
///
/// Fails with `DOC_VALIDATION_FAILED` where the value nests deeper than 100 levels.
pub fn encode_msgpack(value: &crate::value::Value) -> crate::error::Result<Vec<u8>> {
    encode_value(value)
}

/// Returns the one MessagePack value that `bytes` holds, reading every number as a float64 and every binary value
/// as bytes.
///
/// # Errors
///
/// Fails with `PERSISTENCE_LOAD_FAILED` where the bytes are malformed, nest deeper than 100 levels, hold an
/// extension other than the timestamp, or continue past the value.
pub fn decode_msgpack(bytes: &[u8]) -> crate::error::Result<crate::value::Value> {
    decode_value(bytes)
}
