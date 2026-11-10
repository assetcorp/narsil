use super::constants::{POSITION_POOL_START_VALUES, POSTING_POOL_START_ENTRIES};
use super::slices::{
    ALLOCATION_END, ALLOCATION_FREE, MAX_POOL_ENTRIES, SliceAllocator, grow_to, grown_capacity,
};
use crate::error::Result;
use crate::ffi;

pub(crate) const TERM_ORDERED: u8 = 2;
pub(crate) const TERM_POSITIONS: u8 = 4;
const EMPTY_POSITIONS: u32 = 0;
const POSITION_ALLOCATION_WORDS: usize = 2;

#[derive(Clone)]
pub(crate) struct TermColumns {
    pub(crate) slice_start: Vec<u32>,
    pub(crate) slice_class: Vec<u8>,
    pub(crate) lengths: Vec<u32>,
    pub(crate) doc_frequency: Vec<u32>,
    pub(crate) dead_documents: Vec<u32>,
    pub(crate) total_term_frequency: Vec<f64>,
    pub(crate) surface_occurrences: Vec<f64>,
    pub(crate) revision: Vec<u32>,
    pub(crate) flags: Vec<u8>,
}

impl TermColumns {
    pub(crate) fn new(capacity: usize) -> TermColumns {
        TermColumns {
            slice_start: vec![0; capacity],
            slice_class: vec![0; capacity],
            lengths: vec![0; capacity],
            doc_frequency: vec![0; capacity],
            dead_documents: vec![0; capacity],
            total_term_frequency: vec![0.0; capacity],
            surface_occurrences: vec![0.0; capacity],
            revision: vec![0; capacity],
            flags: vec![0; capacity],
        }
    }

    pub(crate) fn match_capacity(&mut self, capacity: usize) {
        grow_to(&mut self.slice_start, capacity);
        grow_to(&mut self.slice_class, capacity);
        grow_to(&mut self.lengths, capacity);
        grow_to(&mut self.doc_frequency, capacity);
        grow_to(&mut self.dead_documents, capacity);
        grow_to(&mut self.total_term_frequency, capacity);
        grow_to(&mut self.surface_occurrences, capacity);
        grow_to(&mut self.revision, capacity);
        grow_to(&mut self.flags, capacity);
    }

    pub(crate) fn raw(&mut self) -> ffi::narsil_term_columns {
        ffi::narsil_term_columns {
            slice_start: self.slice_start.as_mut_ptr(),
            slice_class: self.slice_class.as_mut_ptr(),
            lengths: self.lengths.as_mut_ptr(),
            doc_frequency: self.doc_frequency.as_mut_ptr(),
            dead_documents: self.dead_documents.as_mut_ptr(),
            total_term_frequency: self.total_term_frequency.as_mut_ptr(),
            surface_occurrences: self.surface_occurrences.as_mut_ptr(),
            revision: self.revision.as_mut_ptr(),
            flags: self.flags.as_mut_ptr(),
            capacity: self.flags.len(),
        }
    }

    pub(crate) fn view(&self) -> ffi::narsil_term_columns {
        ffi::narsil_term_columns {
            slice_start: self.slice_start.as_ptr().cast_mut(),
            slice_class: self.slice_class.as_ptr().cast_mut(),
            lengths: self.lengths.as_ptr().cast_mut(),
            doc_frequency: self.doc_frequency.as_ptr().cast_mut(),
            dead_documents: self.dead_documents.as_ptr().cast_mut(),
            total_term_frequency: self.total_term_frequency.as_ptr().cast_mut(),
            surface_occurrences: self.surface_occurrences.as_ptr().cast_mut(),
            revision: self.revision.as_ptr().cast_mut(),
            flags: self.flags.as_ptr().cast_mut(),
            capacity: self.flags.len(),
        }
    }

    pub(crate) fn bytes(&self) -> usize {
        self.flags.len() * (4 * 5 + 8 * 2 + 2)
    }
}

#[derive(Clone)]
pub(crate) struct PostingPool {
    pub(crate) doc_ids: Vec<u32>,
    pub(crate) frequencies: Vec<u16>,
    pub(crate) field_indices: Vec<u16>,
    pub(crate) position_starts: Option<Vec<u32>>,
    allocator: SliceAllocator,
}

impl PostingPool {
    pub(crate) fn new(track_positions: bool) -> PostingPool {
        let capacity = POSTING_POOL_START_ENTRIES;
        PostingPool {
            doc_ids: vec![0; capacity],
            frequencies: vec![0; capacity],
            field_indices: vec![0; capacity],
            position_starts: track_positions.then(|| vec![0; capacity]),
            allocator: SliceAllocator::new(0),
        }
    }

    pub(crate) fn end(&self) -> usize {
        self.allocator.end()
    }

    pub(crate) fn free_entries(&self) -> usize {
        self.allocator.free_entries()
    }

    pub(crate) fn reserve(&mut self, needed: usize) -> Result<()> {
        if needed <= self.doc_ids.len() {
            return Ok(());
        }
        let capacity = grown_capacity(self.doc_ids.len(), needed, MAX_POOL_ENTRIES)?;
        grow_to(&mut self.doc_ids, capacity);
        grow_to(&mut self.frequencies, capacity);
        grow_to(&mut self.field_indices, capacity);
        if let Some(starts) = &mut self.position_starts {
            grow_to(starts, capacity);
        }
        Ok(())
    }

    pub(crate) fn grow(&mut self) -> Result<()> {
        self.reserve(self.doc_ids.len() + 1)
    }

    pub(crate) fn raw(&mut self) -> ffi::narsil_posting_pool {
        ffi::narsil_posting_pool {
            doc_ids: self.doc_ids.as_mut_ptr(),
            frequencies: self.frequencies.as_mut_ptr(),
            field_indices: self.field_indices.as_mut_ptr(),
            position_starts: self
                .position_starts
                .as_mut()
                .map_or(std::ptr::null_mut(), |starts| starts.as_mut_ptr()),
            capacity: self.doc_ids.len(),
            allocator: self.allocator.raw(),
        }
    }

    pub(crate) fn view(&self) -> ffi::narsil_posting_pool {
        ffi::narsil_posting_pool {
            doc_ids: self.doc_ids.as_ptr().cast_mut(),
            frequencies: self.frequencies.as_ptr().cast_mut(),
            field_indices: self.field_indices.as_ptr().cast_mut(),
            position_starts: self
                .position_starts
                .as_ref()
                .map_or(std::ptr::null_mut(), |starts| starts.as_ptr().cast_mut()),
            capacity: self.doc_ids.len(),
            allocator: self.allocator.view(),
        }
    }

    pub(crate) fn bytes(&self) -> usize {
        self.doc_ids.len() * 8
            + self
                .position_starts
                .as_ref()
                .map_or(0, |starts| starts.len() * 4)
            + self.allocator.bytes()
    }
}

#[derive(Clone)]
pub(crate) struct PositionPool {
    values: Vec<u32>,
    allocation: Box<[u32; POSITION_ALLOCATION_WORDS]>,
}

impl PositionPool {
    pub(crate) fn new() -> PositionPool {
        PositionPool {
            values: vec![0; POSITION_POOL_START_VALUES],
            allocation: Box::new([EMPTY_POSITIONS + 1, 0]),
        }
    }

    pub(crate) fn end(&self) -> usize {
        self.allocation[ALLOCATION_END] as usize
    }

    pub(crate) fn free_values(&self) -> usize {
        self.allocation[ALLOCATION_FREE] as usize
    }

    pub(crate) fn values(&self) -> &[u32] {
        &self.values
    }

    pub(crate) fn reserve(&mut self, needed: usize) -> Result<()> {
        if needed <= self.values.len() {
            return Ok(());
        }
        let capacity = grown_capacity(self.values.len(), needed, MAX_POOL_ENTRIES)?;
        grow_to(&mut self.values, capacity);
        Ok(())
    }

    pub(crate) fn grow(&mut self) -> Result<()> {
        self.reserve(self.values.len() + 1)
    }

    pub(crate) fn raw(&mut self) -> ffi::narsil_position_pool {
        ffi::narsil_position_pool {
            values: self.values.as_mut_ptr(),
            capacity: self.values.len(),
            allocation: self.allocation.as_mut_ptr(),
        }
    }

    pub(crate) fn view(&self) -> ffi::narsil_position_pool {
        ffi::narsil_position_pool {
            values: self.values.as_ptr().cast_mut(),
            capacity: self.values.len(),
            allocation: self.allocation.as_ptr().cast_mut(),
        }
    }

    pub(crate) fn bytes(&self) -> usize {
        self.values.len() * 4 + POSITION_ALLOCATION_WORDS * 4
    }
}
