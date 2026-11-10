use std::ptr;

use crate::ffi;
use crate::format::keyword_segment::KeywordSegment;

struct RawFrozen {
    surfaces: ffi::narsil_frozen_strings,
    spellings: ffi::narsil_frozen_strings,
    removal: ffi::narsil_frozen_removal_index,
    segment: ffi::narsil_frozen_segment,
}

pub(crate) struct FrozenView {
    payload_slots: Vec<u32>,
    removal_starts: Vec<u32>,
    removal_rows: Vec<u32>,
    partial_fields: Vec<u8>,
    raw: Box<RawFrozen>,
}

unsafe impl Send for FrozenView {}
unsafe impl Sync for FrozenView {}

fn pointer<T>(values: &[T]) -> *const T {
    if values.is_empty() {
        ptr::null()
    } else {
        values.as_ptr()
    }
}

fn strings(text: &[u8], offsets: &[u32], counts: &[u32]) -> ffi::narsil_frozen_strings {
    ffi::narsil_frozen_strings {
        text: pointer(text),
        text_bytes: text.len(),
        offsets: pointer(offsets),
        counts: pointer(counts),
        count: counts.len(),
    }
}

fn removal_index(payload: &KeywordSegment) -> (Vec<u32>, Vec<u32>) {
    let documents = payload.document_count as usize;
    let mut starts = vec![0u32; documents + 1];
    for &document in &payload.posting_documents {
        if let Some(count) = starts.get_mut(document as usize + 1) {
            *count += 1;
        }
    }
    for at in 1..starts.len() {
        starts[at] += starts[at - 1];
    }
    let mut next = starts.clone();
    let mut rows = vec![0u32; payload.posting_documents.len()];
    for (row, &document) in payload.posting_documents.iter().enumerate() {
        let Some(slot) = next.get_mut(document as usize) else {
            continue;
        };
        if let Some(target) = rows.get_mut(*slot as usize) {
            *target = row as u32;
        }
        *slot += 1;
    }
    (starts, rows)
}

impl FrozenView {
    pub(crate) fn new(payload: &KeywordSegment, resident_postings: bool) -> FrozenView {
        let tokens = payload.token_count();
        let payload_slots: Vec<u32> = (0..tokens as u32).collect();
        let (removal_starts, removal_rows) = if resident_postings {
            removal_index(payload)
        } else {
            (Vec::new(), Vec::new())
        };
        let partial_fields: Vec<u8> = payload
            .field_names
            .iter()
            .map(|name| {
                u8::from(
                    payload
                        .partial_words
                        .as_ref()
                        .is_some_and(|words| words.fields.contains(name)),
                )
            })
            .collect();
        let surfaces = payload
            .surface_forms
            .as_ref()
            .map_or(strings(&[], &[], &[]), |forms| {
                strings(&forms.text, &forms.offsets, &forms.counts)
            });
        let spellings = payload
            .partial_words
            .as_ref()
            .map_or(strings(&[], &[], &[]), |words| {
                strings(&words.text, &words.offsets, &words.counts)
            });
        let mut raw = Box::new(RawFrozen {
            surfaces,
            spellings,
            removal: ffi::narsil_frozen_removal_index {
                starts: pointer(&removal_starts),
                rows: pointer(&removal_rows),
                term_of_slot: pointer(&payload_slots),
            },
            segment: ffi::narsil_frozen_segment {
                terms: strings(
                    &payload.tokens,
                    &payload.token_offsets,
                    &payload.document_frequencies,
                ),
                payload_slots: pointer(&payload_slots),
                posting_offsets: pointer(&payload.posting_offsets),
                posting_documents: pointer(&payload.posting_documents),
                posting_frequencies: pointer(&payload.posting_frequencies),
                posting_fields: pointer(&payload.posting_fields),
                posting_count: payload.posting_documents.len(),
                surfaces: ptr::null(),
                spellings: ptr::null(),
                spelling_tokens: payload
                    .partial_words
                    .as_ref()
                    .map_or(ptr::null(), |words| pointer(&words.tokens)),
                removal_index: ptr::null(),
                partial_fields: pointer(&partial_fields),
                field_count: payload.field_names.len() as u32,
                document_count: payload.document_count,
            },
        });
        if payload.surface_forms.is_some() {
            raw.segment.surfaces = &raw.surfaces;
        }
        if payload.partial_words.is_some() {
            raw.segment.spellings = &raw.spellings;
        }
        if resident_postings {
            raw.segment.removal_index = &raw.removal;
        }
        FrozenView {
            payload_slots,
            removal_starts,
            removal_rows,
            partial_fields,
            raw,
        }
    }

    pub(crate) fn raw(&self) -> *const ffi::narsil_frozen_segment {
        &self.raw.segment
    }

    pub(crate) fn segment(&self) -> &ffi::narsil_frozen_segment {
        &self.raw.segment
    }

    pub(crate) fn surface_count(&self) -> usize {
        self.raw.surfaces.count
    }

    pub(crate) fn spelling_count(&self) -> usize {
        self.raw.spellings.count
    }

    pub(crate) fn payload_slots(&self) -> &[u32] {
        &self.payload_slots
    }

    pub(crate) fn token_count(&self) -> usize {
        self.payload_slots.len()
    }

    pub(crate) fn partial_fields(&self) -> &[u8] {
        &self.partial_fields
    }

    pub(crate) fn bytes(&self) -> usize {
        (self.payload_slots.len() + self.removal_starts.len() + self.removal_rows.len()) * 4
            + self.partial_fields.len()
    }
}
