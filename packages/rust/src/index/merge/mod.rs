mod columns;
mod documents;
mod enum_columns;
mod field_regions;
mod field_targets;
mod inputs;
mod keywords;
mod paged;
mod partial_table;
mod sources;
mod tail_columns;

pub(crate) use paged::merge_paged_segments;
pub(crate) use pattern::tail_pattern_column;

use std::sync::Arc;

use crate::error::Result;
use crate::format::keyword_segment::KeywordSegment;
use crate::index::segment::{SegmentData, SegmentEntry};
use crate::schema::{CompiledSchema, flatten_schema};

use columns::merge_columns;
use documents::merge_documents;
use inputs::prepare;
use keywords::merge_keywords;
use partial_table::partial_table;
use tail_columns::{InputColumns, input_columns};

fn materialised_entries(entries: &[SegmentEntry]) -> Result<Option<Vec<SegmentEntry>>> {
    let holds_paged = entries.iter().any(
        |entry| matches!(&entry.data, SegmentData::Frozen(segment) if segment.paged.is_some()),
    );
    if !holds_paged {
        return Ok(None);
    }
    let mut whole = Vec::with_capacity(entries.len());
    for entry in entries {
        let mut copy = entry.clone();
        if let SegmentData::Frozen(segment) = &entry.data
            && let Some(read) = segment.materialised()?
        {
            copy.data = SegmentData::Frozen(Arc::new(read));
        }
        whole.push(copy);
    }
    Ok(Some(whole))
}

/// Builds one keyword segment payload from the live documents of `entries`, oldest segment first, laid out as the
/// reference merge lays one out: documents numbered in segment order, tokens in code point order, and every column
/// and table counted over the kept documents alone. The payload holds no tombstones and no write records.
///
/// Raises `PERSISTENCE_SAVE_FAILED` where the merged segment would hold more documents, field names, postings, or
/// bytes than its layout can number, and `PARTITION_CORRUPTED` where two live documents share an ID or a segment
/// contradicts itself.
pub(crate) fn merge_segments(
    entries: &[SegmentEntry],
    schema: &CompiledSchema,
) -> Result<KeywordSegment> {
    let materialised = materialised_entries(entries)?;
    let entries = materialised.as_deref().unwrap_or(entries);
    let (inputs, document_count, field_names) = prepare(entries)?;
    let table = merge_documents(&inputs, document_count, &schema.vector_paths)?;
    let keywords = merge_keywords(&inputs, document_count, &field_names)?;
    let mut per_input: Vec<(InputColumns<'_>, &inputs::MergeInput<'_>)> =
        Vec::with_capacity(inputs.len());
    for input in &inputs {
        per_input.push((input_columns(input.entry, schema)?, input));
    }
    let columns = merge_columns(&per_input, document_count)?;
    let partial_words = partial_table(
        &keywords.spellings,
        &keywords.postings,
        schema.partial_fields(),
    )?;
    let postings = keywords.postings;
    Ok(KeywordSegment {
        schema: flatten_schema(&schema.definition),
        tombstones: Vec::new(),
        document_count,
        ids: table.ids,
        id_offsets: table.id_offsets,
        id_order: table.id_order,
        documents: table.documents,
        document_offsets: table.document_offsets,
        field_names,
        tokens: postings.tokens,
        token_offsets: postings.token_offsets,
        document_frequencies: postings.document_frequencies,
        posting_offsets: postings.posting_offsets,
        posting_documents: postings.posting_documents,
        posting_frequencies: postings.posting_frequencies,
        posting_fields: postings.posting_fields,
        positions: postings.positions,
        field_lengths: keywords.field_lengths,
        numeric: columns.numeric,
        sizes: columns.sizes,
        boolean: columns.boolean,
        enums: columns.enums,
        geopoint: columns.geopoint,
        pattern: columns.pattern,
        surface_forms: keywords.surface_forms,
        partial_words,
        write_records: None,
    })
}

/// Builds the keyword segment payload of one segment's live documents, so that a frozen segment opened on it
/// answers every search as `entry` does. A freeze is a merge of that one segment.
pub(crate) fn freeze_segment(
    entry: &SegmentEntry,
    schema: &CompiledSchema,
) -> Result<KeywordSegment> {
    merge_segments(std::slice::from_ref(entry), schema)
}
