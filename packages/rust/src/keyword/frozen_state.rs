use super::constants::{
    MAX_ROOM_ATTEMPTS, PENDING_DOCUMENT_START_CAPACITY, PENDING_REGION_GROWTH_FACTOR,
    PENDING_TOKEN_START_CAPACITY, PENDING_UNIT_START_CAPACITY,
};
use super::frozen::FrozenView;
use super::tokens::{SegmentFieldTokens, raw_fields};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::ffi;
use crate::native::status::core_refused;
use crate::native::workspace::with_workspace;

#[derive(Clone)]
pub(crate) struct FrozenState {
    tombstones: Vec<u32>,
    tombstone_count: u32,
    removed_documents: Vec<u32>,
    removed_occurrences: Vec<f64>,
    removed_surfaces: Vec<u32>,
    removed_spellings: Vec<u32>,
    pending_header: [u32; ffi::NARSIL_PENDING_HEADER_WORDS],
    pending_documents: Vec<u32>,
    pending_tokens: Vec<u32>,
    pending_units: Vec<u16>,
}

fn bit_is_set(words: &[u32], ordinal: u32) -> bool {
    words
        .get((ordinal >> 5) as usize)
        .is_some_and(|word| word & (1 << (ordinal & 31)) != 0)
}

impl FrozenState {
    pub(crate) fn new(view: &FrozenView, document_count: u32) -> FrozenState {
        FrozenState {
            tombstones: vec![0; (document_count as usize).div_ceil(32).max(1)],
            tombstone_count: 0,
            removed_documents: vec![0; view.token_count()],
            removed_occurrences: vec![0.0; view.token_count()],
            removed_surfaces: vec![0; view.surface_count()],
            removed_spellings: vec![0; view.spelling_count()],
            pending_header: [0; ffi::NARSIL_PENDING_HEADER_WORDS],
            pending_documents: vec![0; PENDING_DOCUMENT_START_CAPACITY],
            pending_tokens: vec![0; PENDING_TOKEN_START_CAPACITY * ffi::NARSIL_PENDING_TOKEN_WORDS],
            pending_units: vec![0; PENDING_UNIT_START_CAPACITY],
        }
    }

    pub(crate) fn is_removed(&self, ordinal: u32) -> bool {
        bit_is_set(&self.tombstones, ordinal)
    }

    pub(crate) fn tombstones(&self) -> &[u32] {
        &self.tombstones
    }

    pub(crate) fn removed(&self) -> u32 {
        self.tombstone_count
    }

    pub(crate) fn removed_documents(&self) -> &[u32] {
        &self.removed_documents
    }

    pub(crate) fn removed_surfaces(&self) -> &[u32] {
        &self.removed_surfaces
    }

    pub(crate) fn removed_spellings(&self) -> &[u32] {
        &self.removed_spellings
    }

    pub(crate) fn is_settled(&self) -> bool {
        self.pending_header[ffi::NARSIL_PENDING_DOCUMENTS] == 0
            && self.pending_header[ffi::NARSIL_PENDING_TOKENS] == 0
            && self.pending_header[ffi::NARSIL_PENDING_UNITS] == 0
    }

    pub(crate) fn raw(&mut self) -> ffi::narsil_frozen_segment_state {
        ffi::narsil_frozen_segment_state {
            tombstones: self.tombstones.as_mut_ptr(),
            tombstone_count: &mut self.tombstone_count,
            removed_documents: self.removed_documents.as_mut_ptr(),
            removed_occurrences: self.removed_occurrences.as_mut_ptr(),
            removed_surfaces: self.removed_surfaces.as_mut_ptr(),
            removed_spellings: self.removed_spellings.as_mut_ptr(),
            pending_header: self.pending_header.as_mut_ptr(),
            pending_documents: self.pending_documents.as_mut_ptr(),
            pending_document_capacity: self.pending_documents.len(),
            pending_tokens: self.pending_tokens.as_mut_ptr(),
            pending_token_capacity: self.pending_tokens.len() / ffi::NARSIL_PENDING_TOKEN_WORDS,
            pending_units: self.pending_units.as_mut_ptr(),
            pending_unit_capacity: self.pending_units.len(),
        }
    }

    pub(crate) fn raw_view(&self) -> ffi::narsil_frozen_segment_state {
        ffi::narsil_frozen_segment_state {
            tombstones: self.tombstones.as_ptr().cast_mut(),
            tombstone_count: (&self.tombstone_count as *const u32).cast_mut(),
            removed_documents: self.removed_documents.as_ptr().cast_mut(),
            removed_occurrences: self.removed_occurrences.as_ptr().cast_mut(),
            removed_surfaces: self.removed_surfaces.as_ptr().cast_mut(),
            removed_spellings: self.removed_spellings.as_ptr().cast_mut(),
            pending_header: self.pending_header.as_ptr().cast_mut(),
            pending_documents: self.pending_documents.as_ptr().cast_mut(),
            pending_document_capacity: self.pending_documents.len(),
            pending_tokens: self.pending_tokens.as_ptr().cast_mut(),
            pending_token_capacity: self.pending_tokens.len() / ffi::NARSIL_PENDING_TOKEN_WORDS,
            pending_units: self.pending_units.as_ptr().cast_mut(),
            pending_unit_capacity: self.pending_units.len(),
        }
    }

    fn grow_pending(&mut self) {
        let documents = self.pending_documents.len() * PENDING_REGION_GROWTH_FACTOR;
        let tokens = self.pending_tokens.len() * PENDING_REGION_GROWTH_FACTOR;
        let units = self.pending_units.len() * PENDING_REGION_GROWTH_FACTOR;
        self.pending_documents.resize(documents, 0);
        self.pending_tokens.resize(tokens, 0);
        self.pending_units.resize(units, 0);
    }

    pub(crate) fn remove(
        &mut self,
        view: &FrozenView,
        ordinal: u32,
        fields: &[SegmentFieldTokens<'_>],
        paged: Option<&ffi::narsil_frozen_paged_removals>,
    ) -> Result<bool> {
        if ordinal >= view.segment().document_count || self.is_removed(ordinal) {
            return Ok(false);
        }
        let raw_fields = raw_fields(fields);
        let paged = paged.map_or(std::ptr::null(), |paged| paged as *const _);
        for _ in 0..MAX_ROOM_ATTEMPTS {
            let mut state = self.raw();
            let request = ffi::narsil_remove_frozen_request {
                segment: view.raw(),
                state: &mut state,
                ordinal,
                fields: raw_fields.as_ptr(),
                field_count: raw_fields.len(),
                paged,
            };
            let status = with_workspace(|workspace| {
                Ok(unsafe { ffi::narsil_remove_frozen_document(workspace, &request) })
            })?;
            match status {
                ffi::NARSIL_OK => return Ok(true),
                ffi::NARSIL_NEEDS_ROOM => self.grow_pending(),
                status => return Err(core_refused("a frozen document's removal", status)),
            }
        }
        Err(NarsilError::new(
            ErrorCode::PARTITION_CORRUPTED,
            "The frozen segment found no room for a removal after growing its pending regions",
        ))
    }

    pub(crate) fn settle(
        &mut self,
        view: &FrozenView,
        paged: Option<&ffi::narsil_frozen_paged_removals>,
    ) -> Result<()> {
        if self.is_settled() {
            return Ok(());
        }
        let paged = paged.map_or(std::ptr::null(), |paged| paged as *const _);
        let mut state = self.raw();
        let status =
            with_workspace(|workspace| {
                Ok(unsafe {
                    ffi::narsil_settle_frozen_state(workspace, view.raw(), &mut state, paged)
                })
            })?;
        if status != ffi::NARSIL_OK {
            return Err(core_refused("settling a frozen segment's removals", status));
        }
        Ok(())
    }

    pub(crate) fn bytes(&self) -> usize {
        (self.tombstones.len()
            + self.removed_documents.len()
            + self.removed_surfaces.len()
            + self.removed_spellings.len()
            + self.pending_documents.len()
            + self.pending_tokens.len())
            * 4
            + self.removed_occurrences.len() * 8
            + self.pending_units.len() * 2
            + ffi::NARSIL_PENDING_HEADER_WORDS * 4
    }
}
