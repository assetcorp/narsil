mod documents;
mod lists;

use std::path::PathBuf;

use super::columns::merge_columns;
use super::inputs::{MergeInput, merge_field_lengths, prepare};
use super::postings::MergedPostings;
use super::tail_columns::{InputColumns, input_columns};
use super::words::{merge_partial_words, merge_surfaces};
use crate::error::Result;
use crate::format::keyword_segment::KeywordSegment;
use crate::format::paged_segment::assemble::{AssembledSection, write_assembled};
use crate::format::paged_segment::head::PagedHead;
use crate::format::paged_segment::removal_sort::RemovalWriter;
use crate::format::paged_segment::sink::{ScratchNames, SectionSink};
use crate::format::paged_segment::{head_of, resident_sections, surface_section};
use crate::index::constants::MERGE_READ_CACHE_BYTES;
use crate::index::paged::merge_cache_scope;
use crate::index::segment::SegmentEntry;
use crate::schema::{CompiledSchema, flatten_schema};

use documents::{DocumentSinks, write_documents, write_id_order};
use lists::{ListSinks, posting_upper_bound, tracks_positions, write_merged_lists};

/// A merged paged segment ready to assemble: its head, its resident sections, and the sections that wait in
/// scratch files, which the merge removes once it drops.
pub(crate) struct PagedMerge {
    head: PagedHead,
    sections: Vec<AssembledSection>,
}

impl PagedMerge {
    pub(crate) fn document_count(&self) -> u32 {
        self.head.document_count
    }

    /// Hands every byte of the merged segment's payload to `write` in order.
    pub(crate) fn write_payload(
        &mut self,
        write: &mut dyn FnMut(&[u8]) -> Result<()>,
    ) -> Result<()> {
        write_assembled(&self.head, &mut self.sections, write)
    }
}

fn length_columns(segment: &KeywordSegment) -> Vec<Option<&[u32]>> {
    segment
        .field_names
        .iter()
        .map(|name| {
            segment
                .field_lengths
                .iter()
                .find(|column| &column.field == name)
                .map(|column| column.lengths.as_slice())
        })
        .collect()
}

fn resident_columns(
    inputs: &[MergeInput<'_>],
    schema: &CompiledSchema,
    resident: &mut KeywordSegment,
) -> Result<()> {
    let mut per_input: Vec<(InputColumns<'_>, &MergeInput<'_>)> = Vec::with_capacity(inputs.len());
    for input in inputs {
        per_input.push((input_columns(input.entry, schema)?, input));
    }
    let columns = merge_columns(&per_input)?;
    resident.numeric = columns.numeric;
    resident.sizes = columns.sizes;
    resident.boolean = columns.boolean;
    resident.enums = columns.enums;
    resident.geopoint = columns.geopoint;
    resident.pattern = columns.pattern;
    resident.surface_forms = merge_surfaces(inputs)?;
    let token_table = MergedPostings {
        tokens: std::mem::take(&mut resident.tokens),
        token_offsets: std::mem::take(&mut resident.token_offsets),
        ..MergedPostings::default()
    };
    resident.partial_words = merge_partial_words(inputs, &token_table, schema.partial_fields())?;
    resident.tokens = token_table.tokens;
    resident.token_offsets = token_table.token_offsets;
    Ok(())
}

/// Merges the live documents of `entries` into a paged keyword segment that lists `tombstones`, laid out byte for
/// byte as a merge into a keyword segment and its paged encoding would lay it out, while holding in memory only
/// the per-document and per-token tables, a read cache of `MERGE_READ_CACHE_BYTES`, and fixed write buffers. Every
/// section that grows with the text waits in a scratch file whose path starts with `scratch`.
///
/// Raises `PERSISTENCE_SAVE_FAILED` where the merged segment would hold more than its layout can number or a
/// scratch file fails, and `PARTITION_CORRUPTED` or `PERSISTENCE_LOAD_FAILED` where an input contradicts itself.
pub(crate) fn merge_paged_segments(
    entries: &[SegmentEntry],
    schema: &CompiledSchema,
    tombstones: Vec<String>,
    scratch: PathBuf,
) -> Result<PagedMerge> {
    let _cache = merge_cache_scope(MERGE_READ_CACHE_BYTES);
    let names = ScratchNames::new(scratch);
    let (inputs, document_count, field_names) = prepare(entries)?;
    let mut resident = KeywordSegment {
        schema: flatten_schema(&schema.definition),
        document_count,
        field_names,
        field_lengths: merge_field_lengths(&inputs, document_count),
        ..KeywordSegment::default()
    };
    let mut lists = ListSinks {
        postings: SectionSink::open(&names, "postings")?,
        token_totals: SectionSink::open(&names, "tokenTotals")?,
        positions: match tracks_positions(&inputs) {
            true => Some((
                SectionSink::open(&names, "positionOffsets")?,
                SectionSink::open(&names, "positions")?,
            )),
            false => None,
        },
    };
    let mut removals = RemovalWriter::open(&names, document_count, posting_upper_bound(&inputs))?;
    let written = write_merged_lists(
        &inputs,
        &length_columns(&resident),
        &mut lists,
        &mut removals,
    )?;
    let mut removal_offsets = SectionSink::open(&names, "removalOffsets")?;
    let mut removal_values = SectionSink::open(&names, "removals")?;
    removals.drain(&mut removal_offsets, &mut removal_values)?;
    let mut documents = DocumentSinks {
        documents: SectionSink::open(&names, "documents")?,
        ids: SectionSink::open(&names, "ids")?,
        id_offsets: SectionSink::open(&names, "idOffsets")?,
    };
    let document_blocks = write_documents(&inputs, &schema.vector_paths, &mut documents)?;
    let mut id_order = SectionSink::open(&names, "idOrder")?;
    let id_sample = write_id_order(&inputs, document_count, &mut id_order)?;
    resident.tokens = written.tokens;
    resident.token_offsets = written.token_offsets;
    resident_columns(&inputs, schema, &mut resident)?;
    let mut sections: Vec<AssembledSection> =
        resident_sections(&resident, written.sections, document_blocks, id_sample)
            .into_iter()
            .map(AssembledSection::Held)
            .collect();
    sections.push(AssembledSection::Spilled(lists.postings.finish()?));
    sections.push(AssembledSection::Spilled(lists.token_totals.finish()?));
    if let Some((offsets, values)) = lists.positions {
        sections.push(AssembledSection::Spilled(offsets.finish()?));
        sections.push(AssembledSection::Spilled(values.finish()?));
    }
    for sink in [
        documents.documents,
        documents.ids,
        documents.id_offsets,
        id_order,
        removal_offsets,
        removal_values,
    ] {
        sections.push(AssembledSection::Spilled(sink.finish()?));
    }
    sections.extend(surface_section(&resident).map(AssembledSection::Held));
    Ok(PagedMerge {
        head: head_of(&resident, tombstones),
        sections,
    })
}
