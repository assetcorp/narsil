use std::borrow::Cow;

use crate::error::Result;
use crate::ffi;
use crate::index::frozen::FrozenSegment;
use crate::index::segment::{SegmentData, SegmentEntry};
use crate::index::tail::TailSegment;
use crate::keyword::dictionary::Dictionary;
use crate::keyword::pools::{TERM_ORDERED, TERM_POSITIONS};

#[derive(Default)]
pub(super) struct TokenPostings<'a> {
    documents: Cow<'a, [u32]>,
    fields: Cow<'a, [u16]>,
    starts: Vec<u32>,
    counts: Vec<u32>,
    positions: Cow<'a, [u32]>,
    ordered: bool,
}

impl TokenPostings<'_> {
    pub(super) fn count(&self) -> usize {
        self.documents.len()
    }

    pub(super) fn raw(&self) -> ffi::narsil_phrase_postings {
        ffi::narsil_phrase_postings {
            documents: self.documents.as_ptr(),
            fields: self.fields.as_ptr(),
            position_starts: self.starts.as_ptr(),
            position_counts: self.counts.as_ptr(),
            count: self.documents.len(),
            positions: self.positions.as_ptr(),
            position_count: self.positions.len(),
            ordered: i32::from(self.ordered),
        }
    }
}

fn offset_runs(offsets: &[u32], from: usize, count: usize) -> (Vec<u32>, Vec<u32>) {
    let mut starts = Vec::with_capacity(count);
    let mut counts = Vec::with_capacity(count);
    for row in from..from + count {
        let start = offsets.get(row).copied().unwrap_or(0);
        let end = offsets.get(row + 1).copied().unwrap_or(start);
        starts.push(start);
        counts.push(end.saturating_sub(start));
    }
    (starts, counts)
}

fn frozen_postings(segment: &FrozenSegment, token: usize) -> Result<TokenPostings<'_>> {
    if !segment.tracks_positions() {
        return Ok(TokenPostings::default());
    }
    if segment.paged.is_some() {
        let (Some(list), Some(positions)) =
            (segment.paged_list(token)?, segment.paged_positions(token)?)
        else {
            return Ok(TokenPostings::default());
        };
        let (starts, counts) = offset_runs(&positions.offsets, 0, list.len());
        return Ok(TokenPostings {
            documents: Cow::Owned(list.documents.clone()),
            fields: Cow::Owned(list.fields.clone()),
            starts,
            counts,
            positions: Cow::Owned(positions.values.clone()),
            ordered: true,
        });
    }
    let Some(stored) = &segment.payload.positions else {
        return Ok(TokenPostings::default());
    };
    let range = segment.postings(token);
    let payload = &segment.payload;
    let (starts, counts) = offset_runs(&stored.offsets, range.start, range.len());
    Ok(TokenPostings {
        documents: Cow::Borrowed(payload.posting_documents.get(range.clone()).unwrap_or(&[])),
        fields: Cow::Borrowed(payload.posting_fields.get(range.clone()).unwrap_or(&[])),
        starts,
        counts,
        positions: Cow::Borrowed(&stored.values),
        ordered: segment.postings_ordered(token),
    })
}

fn tail_postings(tail: &TailSegment, token: usize) -> TokenPostings<'_> {
    let keyword = &tail.keyword;
    let columns = &keyword.columns;
    let flags = columns.flags.get(token).copied().unwrap_or(0);
    let (Some(pool), Some(position_starts)) =
        (&keyword.positions, &keyword.postings.position_starts)
    else {
        return TokenPostings::default();
    };
    if !tail.track_positions || flags & TERM_POSITIONS == 0 {
        return TokenPostings::default();
    }
    let start = columns.slice_start.get(token).copied().unwrap_or(0) as usize;
    let length = columns.lengths.get(token).copied().unwrap_or(0) as usize;
    let values = pool.values();
    let mut starts = Vec::with_capacity(length);
    let mut counts = Vec::with_capacity(length);
    for row in start..start + length {
        let held = position_starts.get(row).copied().unwrap_or(0) as usize;
        let count = match held {
            0 => 0,
            _ => values.get(held).copied().unwrap_or(0),
        };
        starts.push(if held == 0 { 0 } else { held as u32 + 1 });
        counts.push(count);
    }
    let postings = &keyword.postings;
    TokenPostings {
        documents: Cow::Borrowed(postings.doc_ids.get(start..start + length).unwrap_or(&[])),
        fields: Cow::Borrowed(
            postings
                .field_indices
                .get(start..start + length)
                .unwrap_or(&[]),
        ),
        starts,
        counts,
        positions: Cow::Borrowed(values),
        ordered: flags & TERM_ORDERED != 0,
    }
}

pub(super) fn token_postings<'a>(
    entry: &'a SegmentEntry,
    dictionary: &Dictionary,
    token: &str,
) -> Result<TokenPostings<'a>> {
    let units: Vec<u16> = token.encode_utf16().collect();
    let Some(ordinal) = dictionary.exact(&units)? else {
        return Ok(TokenPostings::default());
    };
    match &entry.data {
        SegmentData::Frozen(segment) => frozen_postings(segment, ordinal as usize),
        SegmentData::Tail(tail) => Ok(tail_postings(tail, ordinal as usize)),
    }
}
