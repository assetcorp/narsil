mod decode;
mod encode;

pub(crate) use decode::{Decoder, decode_document, decode_value};
pub(crate) use encode::{
    encode_document, encode_value, write_array_header, write_binary, write_map_header, write_nil,
    write_number, write_string, write_uint,
};

pub(crate) const MAX_ENCODING_DEPTH: usize = 100;
const TIMESTAMP_EXTENSION: i8 = -1;
