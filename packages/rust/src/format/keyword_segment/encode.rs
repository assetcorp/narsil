use super::{KEYWORD_SEGMENT_PAYLOAD_VERSION, KeywordSegment};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::keyword_columns::{
    write_boolean_columns, write_enum_columns, write_field_lengths, write_geopoint_columns,
    write_partial_words, write_pattern_columns, write_surface_forms, write_value_columns,
};
use crate::util::bytes::{u16_bytes, u32_bytes, u64_bytes};
use crate::value::{
    Value, write_array_header, write_binary, write_map_header, write_nil, write_string, write_uint,
};

const TOP_LEVEL_ENTRIES: usize = 28;

fn binary(out: &mut Vec<u8>, name: &str, bytes: &[u8]) {
    write_string(out, name);
    write_binary(out, bytes);
}

fn strings(out: &mut Vec<u8>, name: &str, values: &[String]) {
    write_string(out, name);
    write_array_header(out, values.len());
    for value in values {
        write_string(out, value);
    }
}

/// Encodes a keyword segment payload in the key order of the reference writer.
pub(crate) fn encode_keyword_segment(segment: &KeywordSegment) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(
        segment.ids.len()
            + segment.documents.len()
            + segment.tokens.len()
            + segment.posting_documents.len() * 8
            + 1024,
    );
    let entries = if segment.write_records.is_some() {
        TOP_LEVEL_ENTRIES + 2
    } else {
        TOP_LEVEL_ENTRIES
    };
    write_map_header(&mut out, entries);
    write_string(&mut out, "v");
    write_uint(&mut out, KEYWORD_SEGMENT_PAYLOAD_VERSION as u64);
    write_string(&mut out, "schema");
    write_map_header(&mut out, segment.schema.len());
    for (path, type_value) in segment.schema.iter() {
        write_string(&mut out, path);
        let Value::String(type_name) = type_value else {
            return Err(NarsilError::new(
                ErrorCode::PERSISTENCE_SAVE_FAILED,
                format!("The schema gives {path} a type that is not a string"),
            ));
        };
        write_string(&mut out, type_name);
    }
    strings(&mut out, "tombstones", &segment.tombstones);
    write_string(&mut out, "documentCount");
    write_uint(&mut out, segment.document_count as u64);
    binary(&mut out, "ids", &segment.ids);
    binary(&mut out, "idOffsets", &u32_bytes(&segment.id_offsets));
    binary(&mut out, "idOrder", &u32_bytes(&segment.id_order));
    binary(&mut out, "documents", &segment.documents);
    binary(
        &mut out,
        "documentOffsets",
        &u32_bytes(&segment.document_offsets),
    );
    strings(&mut out, "fieldNames", &segment.field_names);
    binary(&mut out, "tokens", &segment.tokens);
    binary(&mut out, "tokenOffsets", &u32_bytes(&segment.token_offsets));
    binary(
        &mut out,
        "documentFrequencies",
        &u32_bytes(&segment.document_frequencies),
    );
    binary(
        &mut out,
        "postingOffsets",
        &u32_bytes(&segment.posting_offsets),
    );
    binary(
        &mut out,
        "postingDocuments",
        &u32_bytes(&segment.posting_documents),
    );
    binary(
        &mut out,
        "postingFrequencies",
        &u16_bytes(&segment.posting_frequencies),
    );
    binary(
        &mut out,
        "postingFields",
        &u16_bytes(&segment.posting_fields),
    );
    match &segment.positions {
        Some(positions) => {
            binary(&mut out, "positionOffsets", &u32_bytes(&positions.offsets));
            binary(&mut out, "positions", &u32_bytes(&positions.values));
        }
        None => {
            write_string(&mut out, "positionOffsets");
            write_nil(&mut out);
            write_string(&mut out, "positions");
            write_nil(&mut out);
        }
    }
    write_string(&mut out, "fieldLengths");
    write_field_lengths(&mut out, &segment.field_lengths);
    write_string(&mut out, "numeric");
    write_value_columns(&mut out, &segment.numeric);
    write_string(&mut out, "sizes");
    write_value_columns(&mut out, &segment.sizes);
    write_string(&mut out, "boolean");
    write_boolean_columns(&mut out, &segment.boolean);
    write_string(&mut out, "enum");
    write_enum_columns(&mut out, &segment.enums);
    write_string(&mut out, "geopoint");
    write_geopoint_columns(&mut out, &segment.geopoint);
    write_string(&mut out, "pattern");
    write_pattern_columns(&mut out, &segment.pattern);
    write_string(&mut out, "surfaceForms");
    write_surface_forms(&mut out, segment.surface_forms.as_ref());
    write_string(&mut out, "partialWords");
    write_partial_words(&mut out, segment.partial_words.as_ref());
    if let Some(records) = &segment.write_records {
        binary(&mut out, "seqNos", &u64_bytes(&records.seq_nos));
        binary(&mut out, "primaryTerms", &u64_bytes(&records.primary_terms));
    }
    Ok(out)
}
