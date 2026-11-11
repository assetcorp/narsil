use super::{
    BooleanColumn, EnumColumn, FieldLengthColumn, GeopointColumn, PartialWords, PatternColumn,
    SurfaceForms, ValueColumn,
};
use crate::util::bytes::{f64_bytes, u32_bytes};
use crate::value::{write_array_header, write_binary, write_map_header, write_nil, write_string};

fn key(out: &mut Vec<u8>, name: &str) {
    write_string(out, name);
}

fn binary_u32(out: &mut Vec<u8>, name: &str, values: &[u32]) {
    key(out, name);
    write_binary(out, &u32_bytes(values));
}

fn binary_f64(out: &mut Vec<u8>, name: &str, values: &[f64]) {
    key(out, name);
    write_binary(out, &f64_bytes(values));
}

fn strings(out: &mut Vec<u8>, name: &str, values: &[String]) {
    key(out, name);
    write_array_header(out, values.len());
    for value in values {
        write_string(out, value);
    }
}

fn field(out: &mut Vec<u8>, entries: usize, path: &str) {
    write_map_header(out, entries);
    key(out, "field");
    write_string(out, path);
}

pub(crate) fn write_field_lengths(out: &mut Vec<u8>, columns: &[FieldLengthColumn]) {
    write_array_header(out, columns.len());
    for column in columns {
        field(out, 2, &column.field);
        binary_u32(out, "lengths", &column.lengths);
    }
}

pub(crate) fn write_value_columns(out: &mut Vec<u8>, columns: &[ValueColumn]) {
    write_array_header(out, columns.len());
    for column in columns {
        field(out, 3, &column.field);
        binary_u32(out, "documents", &column.documents);
        binary_f64(out, "values", &column.values);
    }
}

pub(crate) fn write_boolean_columns(out: &mut Vec<u8>, columns: &[BooleanColumn]) {
    write_array_header(out, columns.len());
    for column in columns {
        field(out, 3, &column.field);
        binary_u32(out, "trueDocuments", &column.true_documents);
        binary_u32(out, "falseDocuments", &column.false_documents);
    }
}

pub(crate) fn write_enum_columns(out: &mut Vec<u8>, columns: &[EnumColumn]) {
    write_array_header(out, columns.len());
    for column in columns {
        field(out, 4, &column.field);
        strings(out, "values", &column.values);
        binary_u32(out, "offsets", &column.offsets);
        binary_u32(out, "documents", &column.documents);
    }
}

pub(crate) fn write_geopoint_columns(out: &mut Vec<u8>, columns: &[GeopointColumn]) {
    write_array_header(out, columns.len());
    for column in columns {
        field(out, 4, &column.field);
        binary_u32(out, "documents", &column.documents);
        binary_f64(out, "latitudes", &column.latitudes);
        binary_f64(out, "longitudes", &column.longitudes);
    }
}

pub(crate) fn write_pattern_columns(out: &mut Vec<u8>, columns: &[PatternColumn]) {
    write_array_header(out, columns.len());
    for column in columns {
        field(out, 5, &column.field);
        binary_u32(out, "documents", &column.documents);
        binary_u32(out, "runs", &column.runs);
        binary_u32(out, "offsets", &column.offsets);
        binary_u32(out, "postings", &column.postings);
    }
}

pub(crate) fn write_surface_forms(out: &mut Vec<u8>, table: Option<&SurfaceForms>) {
    let Some(table) = table.filter(|table| !table.counts.is_empty()) else {
        write_nil(out);
        return;
    };
    write_map_header(out, 3);
    key(out, "text");
    write_binary(out, &table.text);
    binary_u32(out, "offsets", &table.offsets);
    binary_u32(out, "counts", &table.counts);
}

pub(crate) fn write_partial_words(out: &mut Vec<u8>, table: Option<&PartialWords>) {
    let Some(table) = table else {
        write_nil(out);
        return;
    };
    write_map_header(out, 8);
    strings(out, "fields", &table.fields);
    key(out, "text");
    write_binary(out, &table.text);
    binary_u32(out, "offsets", &table.offsets);
    binary_u32(out, "tokens", &table.tokens);
    binary_u32(out, "counts", &table.counts);
    binary_u32(out, "runs", &table.runs);
    binary_u32(out, "runOffsets", &table.run_offsets);
    binary_u32(out, "runEntries", &table.run_entries);
}
