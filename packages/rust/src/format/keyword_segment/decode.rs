use super::{
    KEYWORD_SEGMENT_PAYLOAD_VERSION, KeywordSegment, MAX_SEGMENT_FIELD_NAMES, Positions,
    WriteRecords,
};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::fields::Fields;
use crate::format::keyword_columns::{
    decode_boolean_columns, decode_enum_columns, decode_field_lengths, decode_geopoint_columns,
    decode_partial_words, decode_pattern_columns, decode_surface_forms, decode_value_columns,
};
use crate::format::segment_checks::{
    require_entries_ascend, require_offsets, require_ordinals, require_permutation,
    require_utf8_entries,
};
use crate::schema::require_valid_field_types;
use crate::util::bytes::{u16_list, u32_list, u64_list};
use crate::value::{Map, Value, decode_value};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const ERROR_PREFIX: &str = "Invalid keyword segment: ";

fn u32_field(segment: &Fields<'_>, key: &str) -> Result<Vec<u32>> {
    u32_list(segment.bytes(key, 4)?, key)
}

fn u16_field(segment: &Fields<'_>, key: &str) -> Result<Vec<u16>> {
    u16_list(segment.bytes(key, 2)?, key)
}

fn decode_schema(segment: &Fields<'_>) -> Result<Map> {
    let Some(Value::Object(schema)) = segment.raw("schema") else {
        return Err(segment.error("schema must be a map"));
    };
    require_valid_field_types(schema)?;
    Ok(schema.clone())
}

fn decode_postings(segment: &Fields<'_>, out: &mut KeywordSegment) -> Result<()> {
    let tokens = segment.bytes("tokens", 1)?.to_vec();
    let token_offsets = u32_field(segment, "tokenOffsets")?;
    require_offsets(segment, &token_offsets, tokens.len(), "tokenOffsets")?;
    require_utf8_entries(segment, &tokens, &token_offsets, "tokens")?;
    require_entries_ascend(segment, &tokens, &token_offsets, None, "tokens")?;
    let token_count = token_offsets.len() - 1;
    let document_frequencies = u32_field(segment, "documentFrequencies")?;
    let posting_offsets = u32_field(segment, "postingOffsets")?;
    let posting_documents = u32_field(segment, "postingDocuments")?;
    let posting_frequencies = u16_field(segment, "postingFrequencies")?;
    let posting_fields = u16_field(segment, "postingFields")?;
    segment.require_count(
        document_frequencies.len(),
        token_count,
        "documentFrequencies",
    )?;
    segment.require_count(posting_offsets.len(), token_count + 1, "postingOffsets")?;
    require_offsets(
        segment,
        &posting_offsets,
        posting_documents.len(),
        "postingOffsets",
    )?;
    segment.require_count(
        posting_frequencies.len(),
        posting_documents.len(),
        "postingFrequencies",
    )?;
    segment.require_count(
        posting_fields.len(),
        posting_documents.len(),
        "postingFields",
    )?;
    require_ordinals(
        segment,
        &posting_documents,
        out.document_count,
        "postingDocuments",
    )?;
    let field_count = out.field_names.len();
    if let Some(field) = posting_fields
        .iter()
        .find(|field| **field as usize >= field_count)
    {
        return Err(segment.error(format!(
            "postingFields names field {field} of {field_count}"
        )));
    }
    for (token, frequency) in document_frequencies.iter().enumerate() {
        let postings = posting_offsets[token + 1] - posting_offsets[token];
        if *frequency == 0 || *frequency > postings {
            return Err(segment.error(format!(
                "documentFrequencies gives token {token} a count of {frequency} over {postings} postings"
            )));
        }
    }
    let position_offsets = segment.bytes_or_nil("positionOffsets", 4)?;
    let positions = segment.bytes_or_nil("positions", 4)?;
    out.positions = match (position_offsets, positions) {
        (None, None) => None,
        (Some(offsets), Some(values)) => {
            let offsets = u32_list(offsets, "positionOffsets")?;
            let values = u32_list(values, "positions")?;
            segment.require_count(
                offsets.len(),
                posting_documents.len() + 1,
                "positionOffsets",
            )?;
            require_offsets(segment, &offsets, values.len(), "positionOffsets")?;
            Some(Positions { offsets, values })
        }
        _ => {
            return Err(
                segment.error("positionOffsets and positions must both be nil or both hold bytes")
            );
        }
    };
    out.tokens = tokens;
    out.token_offsets = token_offsets;
    out.document_frequencies = document_frequencies;
    out.posting_offsets = posting_offsets;
    out.posting_documents = posting_documents;
    out.posting_frequencies = posting_frequencies;
    out.posting_fields = posting_fields;
    Ok(())
}

fn decode_ids(segment: &Fields<'_>, out: &mut KeywordSegment) -> Result<()> {
    let ids = segment.bytes("ids", 1)?.to_vec();
    let id_offsets = u32_field(segment, "idOffsets")?;
    let id_order = u32_field(segment, "idOrder")?;
    let count = out.document_count as usize;
    segment.require_count(id_offsets.len(), count + 1, "idOffsets")?;
    segment.require_count(id_order.len(), count, "idOrder")?;
    require_offsets(segment, &id_offsets, ids.len(), "idOffsets")?;
    require_utf8_entries(segment, &ids, &id_offsets, "ids")?;
    require_permutation(segment, &id_order, "idOrder")?;
    require_entries_ascend(segment, &ids, &id_offsets, Some(&id_order), "ids")?;
    out.ids = ids;
    out.id_offsets = id_offsets;
    out.id_order = id_order;
    Ok(())
}

fn decode_documents(segment: &Fields<'_>, out: &mut KeywordSegment) -> Result<()> {
    let documents = segment.bytes("documents", 1)?.to_vec();
    let document_offsets = u32_field(segment, "documentOffsets")?;
    segment.require_count(
        document_offsets.len(),
        out.document_count as usize + 1,
        "documentOffsets",
    )?;
    require_offsets(
        segment,
        &document_offsets,
        documents.len(),
        "documentOffsets",
    )?;
    out.documents = documents;
    out.document_offsets = document_offsets;
    Ok(())
}

fn safe_u64_list(segment: &Fields<'_>, bytes: &[u8], key: &str) -> Result<Vec<u64>> {
    let values = u64_list(bytes, key)?;
    if values.iter().any(|value| *value > MAX_SAFE_INTEGER) {
        return Err(segment.error(format!("{key} holds a value above 2^53 - 1")));
    }
    Ok(values)
}

fn decode_write_records(segment: &Fields<'_>, document_count: u32) -> Result<Option<WriteRecords>> {
    let seq_nos = segment.bytes_or_nil("seqNos", 8)?;
    let terms = segment.bytes_or_nil("primaryTerms", 8)?;
    let (seq_nos, terms) = match (seq_nos, terms) {
        (None, None) => return Ok(None),
        (Some(seq_nos), Some(terms)) => (seq_nos, terms),
        _ => {
            return Err(
                segment.error("seqNos and primaryTerms must both be present or both absent")
            );
        }
    };
    let seq_nos = safe_u64_list(segment, seq_nos, "seqNos")?;
    let primary_terms = safe_u64_list(segment, terms, "primaryTerms")?;
    segment.require_count(seq_nos.len(), document_count as usize, "seqNos")?;
    segment.require_count(primary_terms.len(), document_count as usize, "primaryTerms")?;
    for (at, (seq_no, term)) in seq_nos.iter().zip(&primary_terms).enumerate() {
        if *seq_no == 0 && *term != 0 {
            return Err(segment.error(format!(
                "primaryTerms gives document {at} a term without a seqNo"
            )));
        }
    }
    Ok(Some(WriteRecords {
        seq_nos,
        primary_terms,
    }))
}

fn describe_version(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(value) => value.to_json(),
    }
}

/// Decodes and checks a keyword segment payload, raising `PERSISTENCE_LOAD_FAILED` for any damage.
pub(crate) fn decode_keyword_segment(payload: &[u8]) -> Result<KeywordSegment> {
    let decoded = decode_value(payload).map_err(|error| {
        NarsilError::new(
            ErrorCode::PERSISTENCE_LOAD_FAILED,
            format!(
                "{ERROR_PREFIX}payload is not MessagePack: {}",
                error.message()
            ),
        )
    })?;
    let Value::Object(map) = &decoded else {
        return Err(NarsilError::new(
            ErrorCode::PERSISTENCE_LOAD_FAILED,
            format!("{ERROR_PREFIX}payload must be a map"),
        ));
    };
    let segment = Fields::new(map, ErrorCode::PERSISTENCE_LOAD_FAILED, ERROR_PREFIX);
    if !matches!(segment.raw("v"), Some(Value::Number(version)) if *version == KEYWORD_SEGMENT_PAYLOAD_VERSION as f64)
    {
        return Err(NarsilError::new(
            ErrorCode::ENVELOPE_VERSION_MISMATCH,
            format!(
                "This keyword segment payload was written in layout {}, and this build reads layout {KEYWORD_SEGMENT_PAYLOAD_VERSION} alone",
                describe_version(segment.raw("v"))
            ),
        ));
    }
    let mut out = KeywordSegment {
        schema: decode_schema(&segment)?,
        ..KeywordSegment::default()
    };
    out.tombstones = segment.strings("tombstones")?;
    out.document_count = segment.uint32("documentCount")?;
    out.field_names = segment.strings("fieldNames")?;
    if out.field_names.len() > MAX_SEGMENT_FIELD_NAMES {
        return Err(segment.error(format!(
            "fieldNames holds {} names, above the limit of {MAX_SEGMENT_FIELD_NAMES}",
            out.field_names.len()
        )));
    }
    decode_postings(&segment, &mut out)?;
    decode_ids(&segment, &mut out)?;
    decode_documents(&segment, &mut out)?;
    let count = out.document_count;
    out.field_lengths = decode_field_lengths(&segment, count)?;
    out.numeric = decode_value_columns(&segment, "numeric", count)?;
    out.sizes = decode_value_columns(&segment, "sizes", count)?;
    out.boolean = decode_boolean_columns(&segment, count)?;
    out.enums = decode_enum_columns(&segment, count)?;
    out.geopoint = decode_geopoint_columns(&segment, count)?;
    out.pattern = decode_pattern_columns(&segment, count)?;
    out.surface_forms = decode_surface_forms(&segment)?;
    out.partial_words = decode_partial_words(&segment, out.token_count())?;
    out.write_records = decode_write_records(&segment, count)?;
    Ok(out)
}
