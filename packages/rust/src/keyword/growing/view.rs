use super::GrowingSegment;
use crate::ffi;

pub(crate) struct GrowingRead {
    segment: ffi::narsil_growing_segment,
    positions: ffi::narsil_position_pool,
    surfaces: ffi::narsil_surface_table,
    spellings: ffi::narsil_spelling_table,
}

unsafe impl Send for GrowingRead {}
unsafe impl Sync for GrowingRead {}

impl GrowingRead {
    pub(crate) fn segment(&self) -> *const ffi::narsil_growing_segment {
        &self.segment
    }

    pub(crate) fn dictionary(&self) -> ffi::narsil_term_dictionary {
        let columns = &self.segment.columns;
        ffi::narsil_term_dictionary {
            growing: &self.segment.terms,
            tokens: std::ptr::null(),
            token_bytes: 0,
            offsets: std::ptr::null(),
            offset_count: 0,
            frequencies: columns.doc_frequency,
            frequency_count: columns.capacity,
            removed: columns.dead_documents,
            removed_count: columns.capacity,
        }
    }
}

impl GrowingSegment {
    pub(crate) fn read(&self) -> Box<GrowingRead> {
        let mut read = Box::new(GrowingRead {
            segment: ffi::narsil_growing_segment {
                terms: self.terms.view(),
                columns: self.columns.view(),
                postings: self.postings.view(),
                positions: std::ptr::null_mut(),
                surfaces: std::ptr::null_mut(),
                spellings: std::ptr::null_mut(),
                retired: self.retired.as_ptr().cast_mut(),
                field_lengths: self.field_lengths.as_ptr().cast_mut(),
                total_documents: (&*self.total_documents as *const u32).cast_mut(),
                total_field_lengths: self.total_field_lengths.as_ptr().cast_mut(),
                partial_fields: self.partial_fields.as_ptr(),
                ordinal_capacity: self.ordinal_capacity as u32,
                field_count: self.partial_fields.len() as u32,
            },
            positions: self
                .positions
                .as_ref()
                .map_or_else(|| unsafe { std::mem::zeroed() }, |pool| pool.view()),
            surfaces: self
                .surfaces
                .as_ref()
                .map_or_else(|| unsafe { std::mem::zeroed() }, |table| table.view()),
            spellings: self
                .spellings
                .as_ref()
                .map_or_else(|| unsafe { std::mem::zeroed() }, |table| table.view()),
        });
        if self.positions.is_some() {
            read.segment.positions = &mut read.positions;
        }
        if self.surfaces.is_some() {
            read.segment.surfaces = &mut read.surfaces;
        }
        if self.spellings.is_some() {
            read.segment.spellings = &mut read.spellings;
        }
        read
    }
}
