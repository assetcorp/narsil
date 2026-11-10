use super::{narsil_status, narsil_tokens, narsil_workspace};

pub const NARSIL_LOOKUP_EXACT: u32 = 0;
pub const NARSIL_LOOKUP_TYPO: u32 = 2;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_term_table {
    pub header: *mut u32,
    pub header_words: usize,
    pub slots: *mut i32,
    pub slot_count: usize,
    pub term_offset: *mut u32,
    pub offset_count: usize,
    pub term_length: *mut u32,
    pub length_count: usize,
    pub first_unit_next: *mut u32,
    pub next_count: usize,
    pub first_unit_head: *mut u32,
    pub head_count: usize,
    pub units: *mut u16,
    pub unit_count: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_term_dictionary {
    pub growing: *const narsil_term_table,
    pub tokens: *const u8,
    pub token_bytes: usize,
    pub offsets: *const u32,
    pub offset_count: usize,
    pub frequencies: *const u32,
    pub frequency_count: usize,
    pub removed: *const u32,
    pub removed_count: usize,
}

#[repr(C)]
pub struct narsil_term_lookup {
    pub dictionary: *const narsil_term_dictionary,
    pub text: *const u16,
    pub text_length: usize,
    pub operation: u32,
    pub limit: u32,
    pub tolerance: u32,
    pub prefix_length: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_term_columns {
    pub slice_start: *mut u32,
    pub slice_class: *mut u8,
    pub lengths: *mut u32,
    pub doc_frequency: *mut u32,
    pub dead_documents: *mut u32,
    pub total_term_frequency: *mut f64,
    pub surface_occurrences: *mut f64,
    pub revision: *mut u32,
    pub flags: *mut u8,
    pub capacity: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_slice_allocator {
    pub allocation: *mut u32,
    pub free_heads: *mut u32,
    pub slice_capacities: *const u32,
    pub class_count: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_posting_pool {
    pub doc_ids: *mut u32,
    pub frequencies: *mut u16,
    pub field_indices: *mut u16,
    pub position_starts: *mut u32,
    pub capacity: usize,
    pub allocator: narsil_slice_allocator,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_position_pool {
    pub values: *mut u32,
    pub capacity: usize,
    pub allocation: *mut u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_surface_table {
    pub strings: narsil_term_table,
    pub token: *mut u32,
    pub count: *mut u32,
    pub capacity: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_run_table {
    pub header: *mut u32,
    pub slots: *mut i32,
    pub slot_capacity: usize,
    pub runs: *mut u32,
    pub list_start: *mut u32,
    pub list_length: *mut u32,
    pub list_class: *mut u8,
    pub capacity: usize,
    pub members: *mut u32,
    pub member_capacity: usize,
    pub allocator: narsil_slice_allocator,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_spelling_table {
    pub entries: narsil_surface_table,
    pub code_points: *mut u32,
    pub runs: narsil_run_table,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_growing_segment {
    pub terms: narsil_term_table,
    pub columns: narsil_term_columns,
    pub postings: narsil_posting_pool,
    pub positions: *mut narsil_position_pool,
    pub surfaces: *mut narsil_surface_table,
    pub spellings: *mut narsil_spelling_table,
    pub retired: *mut u32,
    pub field_lengths: *mut u32,
    pub total_documents: *mut u32,
    pub total_field_lengths: *mut f64,
    pub partial_fields: *const u8,
    pub ordinal_capacity: u32,
    pub field_count: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_field_tokens {
    pub field: u16,
    pub tokens: narsil_tokens,
}

#[repr(C)]
pub struct narsil_index_terms_request {
    pub segment: *mut narsil_growing_segment,
    pub ordinal: u32,
    pub fields: *const narsil_field_tokens,
    pub field_count: usize,
}

unsafe extern "C" {
    pub fn narsil_lookup_terms(
        workspace: *mut narsil_workspace,
        request: *const narsil_term_lookup,
        ordinals: *mut u32,
        capacity: usize,
        count: *mut u32,
    ) -> narsil_status;
    pub fn narsil_lookup_exact_batch(
        workspace: *mut narsil_workspace,
        dictionary: *const narsil_term_dictionary,
        units: *const u16,
        unit_count: usize,
        offsets: *const u32,
        offset_count: usize,
        ordinals: *mut u32,
        capacity: usize,
    ) -> narsil_status;
    pub fn narsil_document_frequency(
        dictionary: *const narsil_term_dictionary,
        token: u32,
        frequency: *mut u32,
        capacity: usize,
    ) -> narsil_status;
    pub fn narsil_index_terms(
        workspace: *mut narsil_workspace,
        request: *const narsil_index_terms_request,
    ) -> narsil_status;
    pub fn narsil_remove_document(
        workspace: *mut narsil_workspace,
        request: *const narsil_index_terms_request,
    ) -> narsil_status;
    pub fn narsil_begin_batch(
        workspace: *mut narsil_workspace,
        segment: *mut narsil_growing_segment,
    ) -> narsil_status;
    pub fn narsil_end_batch(
        workspace: *mut narsil_workspace,
        segment: *mut narsil_growing_segment,
    ) -> narsil_status;
    pub fn narsil_pack_tokens(
        tokens: *const narsil_tokens,
        records: *mut u32,
        capacity: usize,
        units: *mut u16,
        unit_capacity: usize,
        unit_count: *mut u32,
    ) -> narsil_status;
}
