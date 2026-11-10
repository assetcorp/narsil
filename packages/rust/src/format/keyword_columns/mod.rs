mod decode;
mod encode;

pub(crate) use decode::{
    decode_boolean_columns, decode_enum_columns, decode_field_lengths, decode_geopoint_columns,
    decode_partial_words, decode_pattern_columns, decode_surface_forms, decode_value_columns,
};
pub(crate) use encode::{
    write_boolean_columns, write_enum_columns, write_field_lengths, write_geopoint_columns,
    write_partial_words, write_pattern_columns, write_surface_forms, write_value_columns,
};

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct FieldLengthColumn {
    pub(crate) field: String,
    pub(crate) lengths: Vec<u32>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct ValueColumn {
    pub(crate) field: String,
    pub(crate) documents: Vec<u32>,
    pub(crate) values: Vec<f64>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct BooleanColumn {
    pub(crate) field: String,
    pub(crate) true_documents: Vec<u32>,
    pub(crate) false_documents: Vec<u32>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct EnumColumn {
    pub(crate) field: String,
    pub(crate) values: Vec<String>,
    pub(crate) offsets: Vec<u32>,
    pub(crate) documents: Vec<u32>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct GeopointColumn {
    pub(crate) field: String,
    pub(crate) documents: Vec<u32>,
    pub(crate) latitudes: Vec<f64>,
    pub(crate) longitudes: Vec<f64>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct PatternColumn {
    pub(crate) field: String,
    pub(crate) documents: Vec<u32>,
    pub(crate) runs: Vec<u32>,
    pub(crate) offsets: Vec<u32>,
    pub(crate) postings: Vec<u32>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct SurfaceForms {
    pub(crate) text: Vec<u8>,
    pub(crate) offsets: Vec<u32>,
    pub(crate) counts: Vec<u32>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct PartialWords {
    pub(crate) fields: Vec<String>,
    pub(crate) text: Vec<u8>,
    pub(crate) offsets: Vec<u32>,
    pub(crate) tokens: Vec<u32>,
    pub(crate) counts: Vec<u32>,
    pub(crate) runs: Vec<u32>,
    pub(crate) run_offsets: Vec<u32>,
    pub(crate) run_entries: Vec<u32>,
}
