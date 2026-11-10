use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::ptr;
use std::sync::Arc;

use super::super::inputs::{MergeInput, as_u32, damaged};
use super::super::sources::bare_input;
use crate::error::Result;
use crate::ffi;
use crate::format::paged_segment::removal_sort::RemovalWriter;
use crate::format::paged_segment::sink::SectionSink;
use crate::format::paged_segment::write_lists::{Row, block_summaries};
use crate::format::paged_segment::{SMALLEST_BLOCK_POSTINGS, TokenSections};
use crate::index::frozen::FrozenSegment;
use crate::index::paged::{PostingList, PostingPositions};
use crate::index::segment::SegmentData;
use crate::native::status::core_refused;
use crate::native::workspace::with_workspace;

pub(super) struct ListSinks {
    pub(super) postings: SectionSink,
    pub(super) token_totals: SectionSink,
    pub(super) positions: Option<(SectionSink, SectionSink)>,
}

pub(super) struct WrittenTokens {
    pub(super) tokens: Vec<u8>,
    pub(super) token_offsets: Vec<u32>,
    pub(super) document_frequencies: Vec<u32>,
    pub(super) sections: TokenSections,
}

pub(super) fn frozen_of<'a>(input: &MergeInput<'a>) -> Result<&'a FrozenSegment> {
    match &input.entry.data {
        SegmentData::Frozen(segment) => Ok(segment),
        SegmentData::Tail(_) => Err(damaged("reaches a paged merge before its tail froze")),
    }
}

pub(super) fn tracks_positions(inputs: &[MergeInput<'_>]) -> Result<bool> {
    for input in inputs {
        if frozen_of(input)?.tracks_positions() {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(super) fn posting_upper_bound(inputs: &[MergeInput<'_>]) -> Result<u64> {
    let mut total = 0u64;
    for input in inputs {
        let held = frozen_of(input)?.payload.posting_offsets.last().copied();
        total = total.saturating_add(u64::from(held.unwrap_or(0)));
    }
    Ok(total)
}

struct Source<'i, 'a> {
    input: &'i MergeInput<'a>,
    segment: &'a FrozenSegment,
    lengths: Vec<*const u32>,
    at: usize,
}

#[derive(Default)]
struct TokenRows {
    inputs: Vec<ffi::narsil_keyword_merge_input>,
    lists: Vec<(Arc<PostingList>, Option<Arc<PostingPositions>>)>,
    row_capacity: usize,
    position_capacity: usize,
    documents: Vec<u32>,
    frequencies: Vec<u16>,
    fields: Vec<u16>,
    starts: Vec<u32>,
    positions: Vec<u32>,
    totals: [f64; 2],
    count: usize,
    rows: Vec<Row>,
}

fn resident_rows(
    raw: &mut ffi::narsil_keyword_merge_input,
    segment: &FrozenSegment,
    token: usize,
) -> Result<usize> {
    let payload = &segment.payload;
    let range = segment.postings(token);
    let outside = || damaged("holds a posting outside its posting lists");
    raw.posting_documents = payload
        .posting_documents
        .get(range.clone())
        .ok_or_else(outside)?
        .as_ptr();
    raw.posting_frequencies = payload
        .posting_frequencies
        .get(range.clone())
        .ok_or_else(outside)?
        .as_ptr();
    raw.posting_fields = payload
        .posting_fields
        .get(range.clone())
        .ok_or_else(outside)?
        .as_ptr();
    raw.posting_count = range.len();
    let Some(positions) = &payload.positions else {
        return Ok(0);
    };
    let offsets = positions
        .offsets
        .get(range.start..=range.end)
        .ok_or_else(outside)?;
    raw.position_offsets = offsets.as_ptr();
    raw.position_values = positions.values.as_ptr();
    raw.position_count = positions.values.len();
    let first = offsets.first().copied().unwrap_or(0);
    let last = offsets.last().copied().unwrap_or(0);
    Ok(last.saturating_sub(first) as usize)
}

impl TokenRows {
    fn clear(&mut self) {
        self.inputs.clear();
        self.lists.clear();
        self.row_capacity = 0;
        self.position_capacity = 0;
        self.count = 0;
    }

    fn append(&mut self, source: &Source<'_, '_>) -> Result<()> {
        let mut raw = bare_input(source.input);
        raw.field_mapping = source.input.field_remap.as_ptr();
        raw.field_count = source.input.field_remap.len() as u32;
        raw.field_lengths = source.lengths.as_ptr();
        let token = source.at;
        let positions = match source.segment.paged_list(token)? {
            None => resident_rows(&mut raw, source.segment, token)?,
            Some(list) => {
                raw.posting_documents = list.documents.as_ptr();
                raw.posting_frequencies = list.frequencies.as_ptr();
                raw.posting_fields = list.fields.as_ptr();
                raw.posting_count = list.len();
                if list.frequencies.len() != list.len() || list.fields.len() != list.len() {
                    return Err(damaged("holds a paged posting list with uneven columns"));
                }
                let held = match source.segment.tracks_positions() {
                    true => source.segment.paged_positions(token)?,
                    false => None,
                };
                let mut count = 0;
                if let Some(held) = &held {
                    if held.offsets.len() != list.len() + 1 {
                        return Err(damaged("holds paged positions that miss a posting"));
                    }
                    raw.position_offsets = held.offsets.as_ptr();
                    raw.position_values = held.values.as_ptr();
                    raw.position_count = held.values.len();
                    count = held.values.len();
                }
                self.lists.push((list, held));
                count
            }
        };
        self.row_capacity += raw.posting_count;
        self.position_capacity += positions;
        self.inputs.push(raw);
        Ok(())
    }

    fn finish(&mut self, document_count: u32, field_count: usize) -> Result<()> {
        if self.row_capacity > self.documents.len() {
            let capacity = self.row_capacity.max(self.documents.len() * 2);
            self.documents.resize(capacity, 0);
            self.frequencies.resize(capacity, 0);
            self.fields.resize(capacity, 0);
            self.starts.resize(capacity + 1, 0);
        }
        if self.starts.is_empty() {
            self.starts.push(0);
        }
        if self.position_capacity > self.positions.len() {
            let capacity = self.position_capacity.max(self.positions.len() * 2);
            self.positions.resize(capacity, 0);
        }
        let request = ffi::narsil_keyword_merge_request {
            inputs: self.inputs.as_ptr(),
            input_count: self.inputs.len(),
            document_count,
            field_count: as_u32(field_count, "field names")?,
            retained_terms: ptr::null(),
        };
        let output = ffi::narsil_posting_merge_output {
            documents: self.documents.as_mut_ptr(),
            frequencies: self.frequencies.as_mut_ptr(),
            fields: self.fields.as_mut_ptr(),
            row_capacity: self.documents.len(),
            position_offsets: self.starts.as_mut_ptr(),
            offset_capacity: self.starts.len(),
            positions: self.positions.as_mut_ptr(),
            position_capacity: self.positions.len(),
            totals: self.totals.as_mut_ptr(),
            total_capacity: self.totals.len(),
        };
        let mut count = 0u32;
        let status = with_workspace(|workspace| {
            Ok(unsafe { ffi::narsil_merge_postings(workspace, &request, &output, &mut count) })
        })?;
        if status != ffi::NARSIL_OK {
            return Err(core_refused("a paged posting merge", status));
        }
        self.count = count as usize;
        self.rows.clear();
        for at in 0..self.count {
            self.rows.push(Row {
                document: self.documents[at],
                frequency: self.frequencies[at],
                field: self.fields[at],
                posting: at,
            });
        }
        Ok(())
    }

    fn position_count(&self) -> usize {
        self.starts.get(self.count).copied().unwrap_or(0) as usize
    }
}

struct Walk<'s, 'c> {
    sinks: &'s mut ListSinks,
    removals: &'s mut RemovalWriter,
    columns: &'c [Option<&'c [u32]>],
    out: WrittenTokens,
    scratch: Vec<u8>,
    postings_written: usize,
    positions_written: usize,
    blocks_written: usize,
}

impl Walk<'_, '_> {
    fn write_token(&mut self, token: &str, rows: &TokenRows) -> Result<()> {
        let number = as_u32(self.out.document_frequencies.len(), "tokens")?;
        let count = rows.count;
        self.scratch.clear();
        for &document in &rows.documents[..count] {
            self.scratch.extend_from_slice(&document.to_le_bytes());
        }
        for &frequency in &rows.frequencies[..count] {
            self.scratch.extend_from_slice(&frequency.to_le_bytes());
        }
        for &field in &rows.fields[..count] {
            self.scratch.extend_from_slice(&field.to_le_bytes());
        }
        self.sinks.postings.write(&self.scratch)?;
        self.sinks
            .token_totals
            .write(&rows.totals[1].to_le_bytes())?;
        if let Some((offsets, values)) = self.sinks.positions.as_mut() {
            for &start in &rows.starts[..count] {
                let written = self.positions_written + start as usize;
                offsets.write_u32(as_u32(written, "positions")?)?;
            }
            let held = &rows.positions[..rows.position_count()];
            self.scratch.clear();
            for &position in held {
                self.scratch.extend_from_slice(&position.to_le_bytes());
            }
            values.write(&self.scratch)?;
            self.positions_written += held.len();
        }
        let mut at = 0;
        while at < count {
            let document = rows.documents[at];
            let mut occurrences = 0u32;
            while at < count && rows.documents[at] == document {
                occurrences = occurrences.saturating_add(u32::from(rows.frequencies[at]));
                at += 1;
            }
            self.removals.add(document, number, occurrences)?;
        }
        let sections = &mut self.out.sections;
        if count > SMALLEST_BLOCK_POSTINGS {
            sections
                .block_lists
                .extend_from_slice(&number.to_le_bytes());
            self.blocks_written +=
                block_summaries(&rows.rows, self.columns, &mut sections.block_summaries)?;
            let blocks = as_u32(self.blocks_written, "blocks")?;
            sections
                .block_list_offsets
                .extend_from_slice(&blocks.to_le_bytes());
        }
        self.postings_written += count;
        let postings = as_u32(self.postings_written, "postings")?;
        sections
            .posting_offsets
            .extend_from_slice(&postings.to_le_bytes());
        let distinct = rows.totals[0] as u32;
        sections
            .document_frequencies
            .extend_from_slice(&distinct.to_le_bytes());
        self.out.document_frequencies.push(distinct);
        self.out.tokens.extend_from_slice(token.as_bytes());
        self.out
            .token_offsets
            .push(as_u32(self.out.tokens.len(), "token bytes")?);
        Ok(())
    }
}

pub(super) fn write_merged_lists(
    inputs: &[MergeInput<'_>],
    document_count: u32,
    columns: &[Option<&[u32]>],
    sinks: &mut ListSinks,
    removals: &mut RemovalWriter,
) -> Result<WrittenTokens> {
    let zero = 0u32.to_le_bytes().to_vec();
    let mut walk = Walk {
        sinks,
        removals,
        columns,
        out: WrittenTokens {
            tokens: Vec::new(),
            token_offsets: vec![0],
            document_frequencies: Vec::new(),
            sections: TokenSections {
                document_frequencies: Vec::new(),
                posting_offsets: zero.clone(),
                block_lists: Vec::new(),
                block_list_offsets: zero,
                block_summaries: Vec::new(),
            },
        },
        scratch: Vec::new(),
        postings_written: 0,
        positions_written: 0,
        blocks_written: 0,
    };
    let mut sources = Vec::with_capacity(inputs.len());
    for input in inputs {
        sources.push(Source {
            input,
            segment: frozen_of(input)?,
            lengths: vec![ptr::null(); input.field_remap.len()],
            at: 0,
        });
    }
    let mut heap = BinaryHeap::new();
    for (at, source) in sources.iter().enumerate() {
        if source.segment.token_count() > 0 {
            heap.push(Reverse((source.segment.token(0), at)));
        }
    }
    let mut rows = TokenRows::default();
    while let Some(Reverse((token, _))) = heap.peek().copied() {
        rows.clear();
        while let Some(Reverse((held, at))) = heap.peek().copied() {
            if held != token {
                break;
            }
            heap.pop();
            let Some(source) = sources.get_mut(at) else {
                continue;
            };
            rows.append(source)?;
            source.at += 1;
            if source.at < source.segment.token_count() {
                let next = source.segment.token(source.at);
                if next <= token {
                    return Err(damaged("lists its tokens out of order"));
                }
                heap.push(Reverse((next, at)));
            }
        }
        rows.finish(document_count, columns.len())?;
        if rows.count == 0 {
            continue;
        }
        walk.write_token(token, &rows)?;
    }
    if let Some((offsets, _)) = walk.sinks.positions.as_mut() {
        offsets.write_u32(as_u32(walk.positions_written, "positions")?)?;
    }
    Ok(walk.out)
}
