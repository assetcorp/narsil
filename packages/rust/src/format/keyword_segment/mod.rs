mod decode;
mod encode;

use crate::format::keyword_columns::{
    BooleanColumn, EnumColumn, FieldLengthColumn, GeopointColumn, PartialWords, PatternColumn,
    SurfaceForms, ValueColumn,
};
use crate::value::Map;

pub(crate) use decode::decode_keyword_segment;
pub(crate) use encode::encode_keyword_segment;

pub(crate) const KEYWORD_SEGMENT_PAYLOAD_VERSION: u8 = 1;
pub(crate) const KEYWORD_SEGMENT_ENVELOPE_VERSION: u8 = 4;
pub(crate) const MAX_SEGMENT_FIELD_NAMES: usize = 65_536;

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Positions {
    pub(crate) offsets: Vec<u32>,
    pub(crate) values: Vec<u32>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct WriteRecords {
    pub(crate) seq_nos: Vec<u64>,
    pub(crate) primary_terms: Vec<u64>,
}

/// The decoded payload of a keyword segment, with every posting list in token order.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct KeywordSegment {
    pub(crate) schema: Map,
    pub(crate) tombstones: Vec<String>,
    pub(crate) document_count: u32,
    pub(crate) ids: Vec<u8>,
    pub(crate) id_offsets: Vec<u32>,
    pub(crate) id_order: Vec<u32>,
    pub(crate) documents: Vec<u8>,
    pub(crate) document_offsets: Vec<u32>,
    pub(crate) field_names: Vec<String>,
    pub(crate) tokens: Vec<u8>,
    pub(crate) token_offsets: Vec<u32>,
    pub(crate) document_frequencies: Vec<u32>,
    pub(crate) posting_offsets: Vec<u32>,
    pub(crate) posting_documents: Vec<u32>,
    pub(crate) posting_frequencies: Vec<u16>,
    pub(crate) posting_fields: Vec<u16>,
    pub(crate) positions: Option<Positions>,
    pub(crate) field_lengths: Vec<FieldLengthColumn>,
    pub(crate) numeric: Vec<ValueColumn>,
    pub(crate) sizes: Vec<ValueColumn>,
    pub(crate) boolean: Vec<BooleanColumn>,
    pub(crate) enums: Vec<EnumColumn>,
    pub(crate) geopoint: Vec<GeopointColumn>,
    pub(crate) pattern: Vec<PatternColumn>,
    pub(crate) surface_forms: Option<SurfaceForms>,
    pub(crate) partial_words: Option<PartialWords>,
    pub(crate) write_records: Option<WriteRecords>,
}

impl KeywordSegment {
    pub(crate) fn token_count(&self) -> usize {
        self.token_offsets.len().saturating_sub(1)
    }
}
