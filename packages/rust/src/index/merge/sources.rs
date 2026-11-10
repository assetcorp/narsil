use std::ptr;

use super::inputs::{MergeInput, as_u32, damaged};
use crate::error::Result;
use crate::ffi;
use crate::index::frozen::FrozenSegment;
use crate::index::segment::SegmentData;
use crate::index::tail::TailSegment;
use crate::keyword::growing::GrowingRead;
use crate::keyword::strings::SurfaceTable;
use crate::keyword::term_table::TermTable;
use crate::util::bytes::offset_entry;

pub(super) struct PairTable {
    pub(super) text: Vec<u8>,
    pub(super) offsets: Vec<u32>,
    pub(super) counts: Vec<u32>,
}

impl PairTable {
    fn new() -> PairTable {
        PairTable {
            text: Vec::new(),
            offsets: vec![0],
            counts: Vec::new(),
        }
    }

    fn push(&mut self, first: &[u8], second: &[u8], count: u32) -> Result<()> {
        self.text.extend_from_slice(first);
        self.offsets
            .push(as_u32(self.text.len(), "surface and spelling bytes")?);
        self.text.extend_from_slice(second);
        self.offsets
            .push(as_u32(self.text.len(), "surface and spelling bytes")?);
        self.counts.push(count);
        Ok(())
    }

    pub(super) fn pair(&self, at: usize) -> Option<(&[u8], &[u8])> {
        let start = *self.offsets.get(at * 2)? as usize;
        let middle = *self.offsets.get(at * 2 + 1)? as usize;
        let end = *self.offsets.get(at * 2 + 2)? as usize;
        Some((self.text.get(start..middle)?, self.text.get(middle..end)?))
    }

    fn raw(&self) -> ffi::narsil_frozen_strings {
        ffi::narsil_frozen_strings {
            text: self.text.as_ptr(),
            text_bytes: self.text.len(),
            offsets: self.offsets.as_ptr(),
            counts: self.counts.as_ptr(),
            count: self.counts.len(),
        }
    }
}

pub(super) struct SourceHold {
    surfaces: PairTable,
    spellings: PairTable,
    raw_surfaces: ffi::narsil_frozen_strings,
    raw_spellings: ffi::narsil_frozen_strings,
    lengths: Vec<*const u32>,
    growing: Option<Box<GrowingRead>>,
}

pub(super) fn full_column(lengths: &[u32], documents: usize) -> Result<*const u32> {
    match lengths.len() >= documents {
        true => Ok(lengths.as_ptr()),
        false => Err(damaged(
            "holds a field length column shorter than its documents",
        )),
    }
}

fn growing_pairs(table: &SurfaceTable, terms: &TermTable, into: &mut PairTable) -> Result<()> {
    for entry in 0..table.len() {
        let count = table.count(entry);
        if count == 0 {
            continue;
        }
        let spelling = String::from_utf16_lossy(table.text(entry));
        let token = String::from_utf16_lossy(terms.text(table.token(entry) as usize));
        into.push(spelling.as_bytes(), token.as_bytes(), count)?;
    }
    Ok(())
}

fn tail_hold(tail: &TailSegment) -> Result<SourceHold> {
    let keyword = &tail.keyword;
    let mut surfaces = PairTable::new();
    if let Some(table) = &keyword.surfaces {
        growing_pairs(table, &keyword.terms, &mut surfaces)?;
    }
    let mut spellings = PairTable::new();
    if let Some(table) = &keyword.spellings {
        growing_pairs(table.entries(), &keyword.terms, &mut spellings)?;
    }
    let lengths = (0..tail.field_names.len())
        .map(|field| {
            let column = keyword.field_length_column(field);
            match column.len() >= tail.len() {
                true => column.as_ptr(),
                false => ptr::null(),
            }
        })
        .collect();
    Ok(SourceHold {
        surfaces,
        spellings,
        raw_surfaces: PairTable::new().raw(),
        raw_spellings: PairTable::new().raw(),
        lengths,
        growing: Some(keyword.read()),
    })
}

fn frozen_hold(input: &MergeInput<'_>, segment: &FrozenSegment) -> Result<SourceHold> {
    let payload = &segment.payload;
    let state = input.entry.state.as_deref();
    let mut surfaces = PairTable::new();
    if let Some(forms) = &payload.surface_forms {
        let removed = state.map_or(&[][..], |state| state.removed_surfaces());
        for (at, &stored) in forms.counts.iter().enumerate() {
            let kept = stored.saturating_sub(removed.get(at).copied().unwrap_or(0));
            if kept > 0 {
                let spelling = offset_entry(&forms.text, &forms.offsets, at * 2);
                let token = offset_entry(&forms.text, &forms.offsets, at * 2 + 1);
                surfaces.push(spelling, token, kept)?;
            }
        }
    }
    let mut spellings = PairTable::new();
    if let Some(words) = &payload.partial_words {
        let removed = state.map_or(&[][..], |state| state.removed_spellings());
        for (at, &stored) in words.counts.iter().enumerate() {
            let kept = stored.saturating_sub(removed.get(at).copied().unwrap_or(0));
            let Some(&token) = words.tokens.get(at) else {
                continue;
            };
            if kept > 0 {
                let spelling = offset_entry(&words.text, &words.offsets, at);
                spellings.push(spelling, segment.token(token as usize).as_bytes(), kept)?;
            }
        }
    }
    let mut lengths = Vec::with_capacity(payload.field_names.len());
    for column in payload.length_columns() {
        lengths.push(match column {
            None => ptr::null(),
            Some(column) => full_column(column, input.remap.len())?,
        });
    }
    Ok(SourceHold {
        surfaces,
        spellings,
        raw_surfaces: PairTable::new().raw(),
        raw_spellings: PairTable::new().raw(),
        lengths,
        growing: None,
    })
}

fn empty_input() -> ffi::narsil_keyword_merge_input {
    ffi::narsil_keyword_merge_input {
        terms: ffi::narsil_frozen_strings {
            text: ptr::null(),
            text_bytes: 0,
            offsets: ptr::null(),
            counts: ptr::null(),
            count: 0,
        },
        payload_slots: ptr::null(),
        posting_offsets: ptr::null(),
        posting_documents: ptr::null(),
        posting_frequencies: ptr::null(),
        posting_fields: ptr::null(),
        posting_count: 0,
        position_offsets: ptr::null(),
        position_values: ptr::null(),
        position_count: 0,
        mapping: ptr::null(),
        field_mapping: ptr::null(),
        field_lengths: ptr::null(),
        document_count: 0,
        field_count: 0,
        surfaces: ptr::null(),
        spellings: ptr::null(),
        growing: ptr::null(),
    }
}

static EMPTY_OFFSETS: [u32; 1] = [0];

pub(super) fn bare_input(input: &MergeInput<'_>) -> ffi::narsil_keyword_merge_input {
    let mut raw = empty_input();
    raw.terms.offsets = EMPTY_OFFSETS.as_ptr();
    raw.posting_offsets = EMPTY_OFFSETS.as_ptr();
    raw.mapping = input.remap.as_ptr();
    raw.document_count = input.remap.len() as u32;
    raw
}

pub(super) fn strip_postings(raw: &mut ffi::narsil_keyword_merge_input) {
    raw.terms = empty_input().terms;
    raw.terms.offsets = EMPTY_OFFSETS.as_ptr();
    raw.payload_slots = ptr::null();
    raw.posting_offsets = EMPTY_OFFSETS.as_ptr();
    raw.posting_documents = ptr::null();
    raw.posting_frequencies = ptr::null();
    raw.posting_fields = ptr::null();
    raw.posting_count = 0;
    raw.position_offsets = ptr::null();
    raw.position_values = ptr::null();
    raw.position_count = 0;
    raw.field_mapping = ptr::null();
    raw.field_lengths = ptr::null();
    raw.field_count = 0;
}

fn raw_input(input: &MergeInput<'_>, hold: &mut SourceHold) -> ffi::narsil_keyword_merge_input {
    hold.raw_surfaces = hold.surfaces.raw();
    hold.raw_spellings = hold.spellings.raw();
    let mut raw = empty_input();
    raw.mapping = input.remap.as_ptr();
    raw.document_count = input.remap.len() as u32;
    raw.field_mapping = input.field_remap.as_ptr();
    raw.field_count = input.field_remap.len() as u32;
    raw.field_lengths = hold.lengths.as_ptr();
    raw.surfaces = &hold.raw_surfaces;
    raw.spellings = &hold.raw_spellings;
    match &input.entry.data {
        SegmentData::Tail(_) => {
            raw.growing = hold
                .growing
                .as_ref()
                .map_or(ptr::null(), |read| read.segment());
        }
        SegmentData::Frozen(segment) => {
            let payload = &segment.payload;
            raw.terms = ffi::narsil_frozen_strings {
                text: payload.tokens.as_ptr(),
                text_bytes: payload.tokens.len(),
                offsets: payload.token_offsets.as_ptr(),
                counts: payload.document_frequencies.as_ptr(),
                count: payload.document_frequencies.len(),
            };
            raw.payload_slots = segment.view.payload_slots().as_ptr();
            raw.posting_offsets = payload.posting_offsets.as_ptr();
            raw.posting_documents = payload.posting_documents.as_ptr();
            raw.posting_frequencies = payload.posting_frequencies.as_ptr();
            raw.posting_fields = payload.posting_fields.as_ptr();
            raw.posting_count = payload.posting_documents.len();
            if let Some(positions) = &payload.positions {
                raw.position_offsets = positions.offsets.as_ptr();
                raw.position_values = positions.values.as_ptr();
                raw.position_count = positions.values.len();
            }
        }
    }
    raw
}

pub(super) struct MergeSources {
    _holds: Box<[SourceHold]>,
    pub(super) inputs: Vec<ffi::narsil_keyword_merge_input>,
}

impl MergeSources {
    pub(super) fn of(inputs: &[MergeInput<'_>]) -> Result<MergeSources> {
        let mut holds = Vec::with_capacity(inputs.len());
        for input in inputs {
            holds.push(match &input.entry.data {
                SegmentData::Tail(tail) => tail_hold(tail)?,
                SegmentData::Frozen(segment) => frozen_hold(input, segment)?,
            });
        }
        let mut holds = holds.into_boxed_slice();
        let raw = inputs
            .iter()
            .zip(holds.iter_mut())
            .map(|(input, hold)| raw_input(input, hold))
            .collect();
        Ok(MergeSources {
            _holds: holds,
            inputs: raw,
        })
    }
}
