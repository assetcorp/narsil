mod room;
mod view;
mod writes;

pub(crate) use view::GrowingRead;
pub(crate) use writes::Indexed;

use super::constants::{ORDINAL_START_CAPACITY, TERM_TABLE_START_CAPACITY};
use super::pools::{PositionPool, PostingPool, TermColumns};
use super::slices::{MAX_POOL_ENTRIES, grown_capacity};
use super::strings::{SpellingTable, SurfaceTable};
use super::term_table::TermTable;
use crate::error::Result;
use crate::ffi;

const BITS_PER_WORD: usize = 32;
const MAX_FIELDS: usize = 1 << 16;

struct Views {
    segment: ffi::narsil_growing_segment,
    positions: ffi::narsil_position_pool,
    surfaces: ffi::narsil_surface_table,
    spellings: ffi::narsil_spelling_table,
}

fn empty_views() -> Box<Views> {
    Box::new(unsafe { std::mem::zeroed() })
}

pub(crate) struct GrowingSegment {
    pub(crate) terms: TermTable,
    pub(crate) columns: TermColumns,
    pub(crate) postings: PostingPool,
    pub(crate) positions: Option<PositionPool>,
    pub(crate) surfaces: Option<SurfaceTable>,
    pub(crate) spellings: Option<SpellingTable>,
    retired: Vec<u32>,
    field_lengths: Vec<u32>,
    total_documents: Box<u32>,
    total_field_lengths: Vec<f64>,
    partial_fields: Vec<u8>,
    ordinal_capacity: usize,
    views: Box<Views>,
}

unsafe impl Send for GrowingSegment {}
unsafe impl Sync for GrowingSegment {}

impl Clone for GrowingSegment {
    fn clone(&self) -> GrowingSegment {
        GrowingSegment {
            terms: self.terms.clone(),
            columns: self.columns.clone(),
            postings: self.postings.clone(),
            positions: self.positions.clone(),
            surfaces: self.surfaces.clone(),
            spellings: self.spellings.clone(),
            retired: self.retired.clone(),
            field_lengths: self.field_lengths.clone(),
            total_documents: self.total_documents.clone(),
            total_field_lengths: self.total_field_lengths.clone(),
            partial_fields: self.partial_fields.clone(),
            ordinal_capacity: self.ordinal_capacity,
            views: empty_views(),
        }
    }
}

fn words_for(capacity: usize) -> usize {
    capacity.div_ceil(BITS_PER_WORD).max(1)
}

impl GrowingSegment {
    pub(crate) fn new(track_positions: bool) -> GrowingSegment {
        let terms = TermTable::new(TERM_TABLE_START_CAPACITY);
        let columns = TermColumns::new(terms.capacity());
        GrowingSegment {
            terms,
            columns,
            postings: PostingPool::new(track_positions),
            positions: track_positions.then(PositionPool::new),
            surfaces: None,
            spellings: None,
            retired: vec![0; words_for(ORDINAL_START_CAPACITY)],
            field_lengths: Vec::new(),
            total_documents: Box::new(0),
            total_field_lengths: Vec::new(),
            partial_fields: Vec::new(),
            ordinal_capacity: ORDINAL_START_CAPACITY,
            views: empty_views(),
        }
    }

    pub(crate) fn total_documents(&self) -> u32 {
        *self.total_documents
    }

    pub(crate) fn field_length_column(&self, field: usize) -> &[u32] {
        let start = field * self.ordinal_capacity;
        self.field_lengths
            .get(start..start + self.ordinal_capacity)
            .unwrap_or_default()
    }

    pub(crate) fn field_length(&self, field: usize, ordinal: u32) -> u32 {
        self.field_length_column(field)
            .get(ordinal as usize)
            .copied()
            .unwrap_or(0)
    }

    pub(crate) fn retired(&self) -> &[u32] {
        &self.retired
    }

    pub(crate) fn is_retired(&self, ordinal: u32) -> bool {
        self.retired
            .get(ordinal as usize / BITS_PER_WORD)
            .is_some_and(|word| word & (1 << (ordinal as usize % BITS_PER_WORD)) != 0)
    }

    pub(crate) fn reserve_fields(&mut self, ordinals: usize, fields: usize) -> Result<()> {
        let fields = fields.max(self.partial_fields.len()).min(MAX_FIELDS);
        let capacity = if ordinals > self.ordinal_capacity {
            grown_capacity(self.ordinal_capacity, ordinals, MAX_POOL_ENTRIES)?
        } else {
            self.ordinal_capacity
        };
        if capacity == self.ordinal_capacity && fields == self.partial_fields.len() {
            return Ok(());
        }
        let mut lengths = vec![0u32; capacity * fields];
        for field in 0..self.partial_fields.len() {
            let start = field * self.ordinal_capacity;
            let held = &self.field_lengths[start..start + self.ordinal_capacity];
            lengths[field * capacity..field * capacity + self.ordinal_capacity]
                .copy_from_slice(held);
        }
        self.field_lengths = lengths;
        self.total_field_lengths.resize(fields, 0.0);
        self.partial_fields.resize(fields, 0);
        self.ordinal_capacity = capacity;
        let words = words_for(capacity);
        if words > self.retired.len() {
            self.retired.resize(words, 0);
        }
        Ok(())
    }

    pub(crate) fn mark_partial(&mut self, field: usize) {
        if let Some(mark) = self.partial_fields.get_mut(field)
            && *mark == 0
        {
            *mark = 1;
            self.spellings.get_or_insert_with(SpellingTable::new);
        }
    }

    pub(crate) fn raw(&mut self) -> *mut ffi::narsil_growing_segment {
        let views = &mut *self.views;
        let positions = match &mut self.positions {
            Some(pool) => {
                views.positions = pool.raw();
                &mut views.positions as *mut ffi::narsil_position_pool
            }
            None => std::ptr::null_mut(),
        };
        let surfaces = match &mut self.surfaces {
            Some(table) => {
                views.surfaces = table.raw();
                &mut views.surfaces as *mut ffi::narsil_surface_table
            }
            None => std::ptr::null_mut(),
        };
        let spellings = match &mut self.spellings {
            Some(table) => {
                views.spellings = table.raw();
                &mut views.spellings as *mut ffi::narsil_spelling_table
            }
            None => std::ptr::null_mut(),
        };
        self.columns.match_capacity(self.terms.capacity());
        views.segment = ffi::narsil_growing_segment {
            terms: self.terms.raw(),
            columns: self.columns.raw(),
            postings: self.postings.raw(),
            positions,
            surfaces,
            spellings,
            retired: self.retired.as_mut_ptr(),
            field_lengths: self.field_lengths.as_mut_ptr(),
            total_documents: &mut *self.total_documents,
            total_field_lengths: self.total_field_lengths.as_mut_ptr(),
            partial_fields: self.partial_fields.as_ptr(),
            ordinal_capacity: self.ordinal_capacity as u32,
            field_count: self.partial_fields.len() as u32,
        };
        &mut views.segment
    }

    pub(crate) fn dictionary(&mut self) -> ffi::narsil_term_dictionary {
        let views = &mut *self.views;
        views.segment.terms = self.terms.raw();
        ffi::narsil_term_dictionary {
            growing: &views.segment.terms,
            tokens: std::ptr::null(),
            token_bytes: 0,
            offsets: std::ptr::null(),
            offset_count: 0,
            frequencies: self.columns.doc_frequency.as_ptr(),
            frequency_count: self.columns.doc_frequency.len(),
            removed: self.columns.dead_documents.as_ptr(),
            removed_count: self.columns.dead_documents.len(),
            exact_slots: std::ptr::null(),
            exact_slot_count: 0,
        }
    }

    pub(crate) fn bytes(&self) -> usize {
        self.terms.bytes()
            + self.columns.bytes()
            + self.postings.bytes()
            + self.positions.as_ref().map_or(0, PositionPool::bytes)
            + self.surfaces.as_ref().map_or(0, SurfaceTable::bytes)
            + self.spellings.as_ref().map_or(0, SpellingTable::bytes)
            + self.retired.len() * 4
            + self.field_lengths.len() * 4
            + self.total_field_lengths.len() * 8
            + self.partial_fields.len()
    }
}
