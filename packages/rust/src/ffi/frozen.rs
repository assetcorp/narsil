use super::{
    narsil_field_tokens, narsil_page_cache, narsil_page_fault, narsil_page_section, narsil_status,
    narsil_workspace,
};

pub const NARSIL_PENDING_HEADER_WORDS: usize = 8;
pub const NARSIL_PENDING_DOCUMENTS: usize = 0;
pub const NARSIL_PENDING_TOKENS: usize = 1;
pub const NARSIL_PENDING_UNITS: usize = 2;
pub const NARSIL_PENDING_TOKEN_WORDS: usize = 5;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_frozen_strings {
    pub text: *const u8,
    pub text_bytes: usize,
    pub offsets: *const u32,
    pub counts: *const u32,
    pub count: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_frozen_removal_index {
    pub starts: *const u32,
    pub rows: *const u32,
    pub term_of_slot: *const u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_frozen_segment {
    pub terms: narsil_frozen_strings,
    pub payload_slots: *const u32,
    pub posting_offsets: *const u32,
    pub posting_documents: *const u32,
    pub posting_frequencies: *const u16,
    pub posting_fields: *const u16,
    pub posting_count: usize,
    pub surfaces: *const narsil_frozen_strings,
    pub spellings: *const narsil_frozen_strings,
    pub spelling_tokens: *const u32,
    pub removal_index: *const narsil_frozen_removal_index,
    pub partial_fields: *const u8,
    pub field_count: u32,
    pub document_count: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_frozen_segment_state {
    pub tombstones: *mut u32,
    pub tombstone_count: *mut u32,
    pub removed_documents: *mut u32,
    pub removed_occurrences: *mut f64,
    pub removed_surfaces: *mut u32,
    pub removed_spellings: *mut u32,
    pub pending_header: *mut u32,
    pub pending_documents: *mut u32,
    pub pending_document_capacity: usize,
    pub pending_tokens: *mut u32,
    pub pending_token_capacity: usize,
    pub pending_units: *mut u16,
    pub pending_unit_capacity: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_frozen_paged_removals {
    pub cache: *mut narsil_page_cache,
    pub offsets: *const narsil_page_section,
    pub values: *const narsil_page_section,
    pub fault: *mut narsil_page_fault,
}

#[repr(C)]
pub struct narsil_remove_frozen_request {
    pub segment: *const narsil_frozen_segment,
    pub state: *mut narsil_frozen_segment_state,
    pub ordinal: u32,
    pub fields: *const narsil_field_tokens,
    pub field_count: usize,
    pub paged: *const narsil_frozen_paged_removals,
}

#[repr(C)]
pub struct narsil_frozen_removal_output {
    pub entries: *mut u32,
    pub values: *mut f64,
    pub entry_capacity: usize,
    pub value_capacity: usize,
}

unsafe extern "C" {
    pub fn narsil_remove_frozen_document(
        workspace: *mut narsil_workspace,
        request: *const narsil_remove_frozen_request,
    ) -> narsil_status;
    pub fn narsil_prepare_frozen_removal(
        workspace: *mut narsil_workspace,
        request: *const narsil_remove_frozen_request,
        output: *const narsil_frozen_removal_output,
        count: *mut usize,
    ) -> narsil_status;
    pub fn narsil_settle_frozen_state(
        workspace: *mut narsil_workspace,
        segment: *const narsil_frozen_segment,
        state: *mut narsil_frozen_segment_state,
        paged: *const narsil_frozen_paged_removals,
    ) -> narsil_status;
}
