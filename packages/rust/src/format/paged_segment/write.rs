use super::ID_SAMPLE_INTERVAL;
use super::blocks::DocumentBlocks;
use super::head::{EncodedHead, PagedHead, PlannedSection, SectionPlan, encode_paged_head};
use super::write_lists::write_lists;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::keyword_columns::{
    write_boolean_columns, write_enum_columns, write_field_lengths, write_geopoint_columns,
    write_partial_words, write_pattern_columns, write_surface_forms, write_value_columns,
};
use crate::format::keyword_segment::KeywordSegment;
use crate::util::bytes::{u32_bytes, u64_bytes};
use crate::value::{write_array_header, write_string, write_uint};

/// A paged keyword segment ready to write: the head and every section in the order of the payload.
pub(crate) struct PagedSegmentFile {
    encoded: EncodedHead,
    sections: Vec<PlannedSection>,
}

/// Returns the zero bytes that place a section at `offset` when the payload so far holds `cursor` bytes.
pub(crate) fn padding_before(offset: u64, cursor: u64) -> Result<Vec<u8>> {
    let padding = offset.checked_sub(cursor).ok_or_else(|| {
        NarsilError::new(
            ErrorCode::PERSISTENCE_SAVE_FAILED,
            format!("Section offset {offset} of a paged segment does not follow byte {cursor}"),
        )
    })?;
    Ok(vec![0u8; padding as usize])
}

impl PagedSegmentFile {
    pub(crate) fn payload_length(&self) -> u64 {
        self.encoded.payload_length
    }

    /// Hands every byte of the payload to `write` in order, padding each section to its 4-byte boundary.
    pub(crate) fn write_payload(&self, write: &mut dyn FnMut(&[u8]) -> Result<()>) -> Result<()> {
        write(&self.encoded.prefix)?;
        write(&self.encoded.head)?;
        let mut cursor = (self.encoded.prefix.len() + self.encoded.head.len()) as u64;
        for (section, &offset) in self.sections.iter().zip(&self.encoded.offsets) {
            write(&padding_before(offset, cursor)?)?;
            write(&section.bytes)?;
            cursor = offset + section.bytes.len() as u64;
        }
        Ok(())
    }
}

fn entry<'a>(blob: &'a [u8], offsets: &[u32], at: usize) -> &'a [u8] {
    let start = offsets.get(at).copied().unwrap_or(0) as usize;
    let end = offsets.get(at + 1).copied().unwrap_or(0) as usize;
    blob.get(start..end).unwrap_or(&[])
}

/// Encodes the `idSample` section: every `ID_SAMPLE_INTERVAL`th ID of the ascending ID order with its position.
pub(crate) fn encode_id_sample(sampled: &[(u64, String)]) -> Vec<u8> {
    let mut out = Vec::new();
    write_array_header(&mut out, sampled.len());
    for (position, id) in sampled {
        write_array_header(&mut out, 2);
        write_string(&mut out, id);
        write_uint(&mut out, *position);
    }
    out
}

fn id_sample(segment: &KeywordSegment) -> Vec<u8> {
    let sampled: Vec<(u64, String)> = segment
        .id_order
        .iter()
        .enumerate()
        .step_by(ID_SAMPLE_INTERVAL)
        .map(|(position, &ordinal)| {
            let id = entry(&segment.ids, &segment.id_offsets, ordinal as usize);
            (
                position as u64,
                std::str::from_utf8(id).unwrap_or("").to_string(),
            )
        })
        .collect();
    encode_id_sample(&sampled)
}

fn encoded(write: impl FnOnce(&mut Vec<u8>)) -> Vec<u8> {
    let mut out = Vec::new();
    write(&mut out);
    out
}

fn planned(name: &'static str, bytes: Vec<u8>) -> PlannedSection {
    PlannedSection { name, bytes }
}

/// The sections of a paged segment that its token walk builds and that a reader holds in memory.
pub(crate) struct TokenSections {
    pub(crate) document_frequencies: Vec<u8>,
    pub(crate) posting_offsets: Vec<u8>,
    pub(crate) block_lists: Vec<u8>,
    pub(crate) block_list_offsets: Vec<u8>,
    pub(crate) block_summaries: Vec<u8>,
}

/// Returns the resident sections of a paged segment in the order of the reference writer, taking the token
/// table and every column from `segment` and the token sections, document blocks, and ID sample as built.
pub(crate) fn resident_sections(
    segment: &KeywordSegment,
    token: TokenSections,
    document_blocks: Vec<u8>,
    id_sample: Vec<u8>,
) -> Vec<PlannedSection> {
    vec![
        planned("tokens", segment.tokens.clone()),
        planned("tokenOffsets", u32_bytes(&segment.token_offsets)),
        planned("documentFrequencies", token.document_frequencies),
        planned("postingOffsets", token.posting_offsets),
        planned("blockLists", token.block_lists),
        planned("blockListOffsets", token.block_list_offsets),
        planned("blockSummaries", token.block_summaries),
        planned(
            "fieldLengths",
            encoded(|out| write_field_lengths(out, &segment.field_lengths)),
        ),
        planned(
            "numeric",
            encoded(|out| write_value_columns(out, &segment.numeric)),
        ),
        planned(
            "sizes",
            encoded(|out| write_value_columns(out, &segment.sizes)),
        ),
        planned(
            "boolean",
            encoded(|out| write_boolean_columns(out, &segment.boolean)),
        ),
        planned(
            "enum",
            encoded(|out| write_enum_columns(out, &segment.enums)),
        ),
        planned(
            "geopoint",
            encoded(|out| write_geopoint_columns(out, &segment.geopoint)),
        ),
        planned(
            "pattern",
            encoded(|out| write_pattern_columns(out, &segment.pattern)),
        ),
        planned(
            "partialWords",
            encoded(|out| write_partial_words(out, segment.partial_words.as_ref())),
        ),
        planned("documentBlocks", document_blocks),
        planned("idSample", id_sample),
    ]
}

/// Returns the `surfaceForms` section of `segment`, which a paged segment holds only where it keeps a surface.
pub(crate) fn surface_section(segment: &KeywordSegment) -> Option<PlannedSection> {
    let forms = segment
        .surface_forms
        .as_ref()
        .filter(|forms| !forms.counts.is_empty())?;
    Some(planned(
        "surfaceForms",
        encoded(|out| write_surface_forms(out, Some(forms))),
    ))
}

/// Returns the head fields of a paged segment that holds `segment`'s documents and lists `tombstones`.
pub(crate) fn head_of(segment: &KeywordSegment, tombstones: Vec<String>) -> PagedHead {
    PagedHead {
        schema: segment.schema.clone(),
        tombstones,
        document_count: segment.document_count,
        field_names: segment.field_names.clone(),
        sections: Vec::new(),
    }
}

/// Lays out `segment` as a paged keyword segment that lists `tombstones`, in the section order of the reference
/// writer, so that a reader can open it without reading it whole.
pub(crate) fn encode_paged_segment(
    segment: &KeywordSegment,
    tombstones: Vec<String>,
) -> Result<PagedSegmentFile> {
    let lists = write_lists(segment)?;
    let mut documents = Vec::new();
    let mut blocks = DocumentBlocks::default();
    let mut append = |bytes: &[u8]| -> Result<()> {
        documents.extend_from_slice(bytes);
        Ok(())
    };
    for ordinal in 0..segment.document_count {
        let stored = entry(
            &segment.documents,
            &segment.document_offsets,
            ordinal as usize,
        );
        blocks.add(ordinal, stored, &mut append)?;
    }
    let document_blocks = blocks.finish(&mut append)?;
    let token = TokenSections {
        document_frequencies: lists.document_frequencies,
        posting_offsets: lists.posting_offsets,
        block_lists: lists.block_lists,
        block_list_offsets: lists.block_list_offsets,
        block_summaries: lists.block_summaries,
    };
    let mut sections = resident_sections(segment, token, document_blocks, id_sample(segment));
    sections.push(planned("postings", lists.postings));
    sections.push(planned("tokenTotals", lists.token_totals));
    if segment.positions.is_some() {
        sections.push(planned("positionOffsets", lists.position_offsets));
        sections.push(planned("positions", lists.positions));
    }
    sections.push(planned("documents", documents));
    sections.push(planned("ids", segment.ids.clone()));
    sections.push(planned("idOffsets", u32_bytes(&segment.id_offsets)));
    sections.push(planned("idOrder", u32_bytes(&segment.id_order)));
    sections.push(planned("removalOffsets", lists.removal_offsets));
    sections.push(planned("removals", lists.removals));
    if let Some(records) = &segment.write_records {
        sections.push(planned("seqNos", u64_bytes(&records.seq_nos)));
        sections.push(planned("primaryTerms", u64_bytes(&records.primary_terms)));
    }
    sections.extend(surface_section(segment));
    let plans: Vec<SectionPlan> = sections.iter().map(SectionPlan::of).collect();
    let encoded = encode_paged_head(&head_of(segment, tombstones), &plans)?;
    Ok(PagedSegmentFile { encoded, sections })
}
