use std::ffi::c_void;

use super::{narsil_frozen_strings, narsil_growing_segment, narsil_status, narsil_workspace};

pub const NARSIL_MERGE_NUMERIC: u32 = 1;
pub const NARSIL_MERGE_BOOLEAN: u32 = 2;
pub const NARSIL_MERGE_ENUM: u32 = 3;
pub const NARSIL_MERGE_GEO: u32 = 4;
pub const NARSIL_MERGE_STORED: u32 = 5;
pub const NARSIL_MERGE_PATTERN: u32 = 6;
pub const NARSIL_FIELD_MERGE_REGIONS: usize = 8;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_keyword_merge_input {
    pub terms: narsil_frozen_strings,
    pub payload_slots: *const u32,
    pub posting_offsets: *const u32,
    pub posting_documents: *const u32,
    pub posting_frequencies: *const u16,
    pub posting_fields: *const u16,
    pub posting_count: usize,
    pub position_offsets: *const u32,
    pub position_values: *const u32,
    pub position_count: usize,
    pub mapping: *const u32,
    pub field_mapping: *const u16,
    pub field_lengths: *const *const u32,
    pub document_count: u32,
    pub field_count: u32,
    pub surfaces: *const narsil_frozen_strings,
    pub spellings: *const narsil_frozen_strings,
    pub growing: *const narsil_growing_segment,
}

#[repr(C)]
pub struct narsil_keyword_merge_request {
    pub inputs: *const narsil_keyword_merge_input,
    pub input_count: usize,
    pub document_count: u32,
    pub field_count: u32,
    pub retained_terms: *const narsil_frozen_strings,
}

#[repr(C)]
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct narsil_keyword_merge_sizes {
    pub terms: u32,
    pub term_bytes: u32,
    pub postings: u32,
    pub positions: u32,
    pub has_positions: u32,
    pub surfaces: u32,
    pub surface_bytes: u32,
    pub spellings: u32,
    pub spelling_bytes: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_merged_strings {
    pub text: *mut u8,
    pub offsets: *mut u32,
    pub counts: *mut u32,
    pub count_capacity: usize,
    pub text_capacity: usize,
    pub offset_capacity: usize,
}

#[repr(C)]
pub struct narsil_keyword_merge_output {
    pub terms: narsil_merged_strings,
    pub posting_offsets: *mut u32,
    pub posting_offset_capacity: usize,
    pub posting_documents: *mut u32,
    pub posting_frequencies: *mut u16,
    pub posting_fields: *mut u16,
    pub posting_capacity: usize,
    pub position_offsets: *mut u32,
    pub position_offset_capacity: usize,
    pub position_values: *mut u32,
    pub position_capacity: usize,
    pub field_lengths: *mut u32,
    pub field_length_capacity: usize,
    pub total_field_lengths: *mut f64,
    pub field_count: usize,
    pub surfaces: narsil_merged_strings,
    pub spellings: narsil_merged_strings,
}

#[repr(C)]
pub struct narsil_posting_merge_output {
    pub documents: *mut u32,
    pub frequencies: *mut u16,
    pub fields: *mut u16,
    pub row_capacity: usize,
    pub position_offsets: *mut u32,
    pub offset_capacity: usize,
    pub positions: *mut u32,
    pub position_capacity: usize,
    pub totals: *mut f64,
    pub total_capacity: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_field_merge_region {
    pub data: *const c_void,
    pub length: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_field_merge_source {
    pub mapping: *const u32,
    pub document_count: usize,
    pub regions: [narsil_field_merge_region; NARSIL_FIELD_MERGE_REGIONS],
}

#[repr(C)]
pub struct narsil_field_merge_request {
    pub kind: u32,
    pub document_count: u32,
    pub sources: *const narsil_field_merge_source,
    pub source_count: usize,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct narsil_field_merge_sizes {
    pub lengths: [u32; NARSIL_FIELD_MERGE_REGIONS],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_field_merge_target {
    pub data: *mut c_void,
    pub capacity: usize,
}

#[repr(C)]
pub struct narsil_field_merge_output {
    pub regions: [narsil_field_merge_target; NARSIL_FIELD_MERGE_REGIONS],
}

unsafe extern "C" {
    pub fn narsil_measure_merge(
        workspace: *mut narsil_workspace,
        request: *const narsil_keyword_merge_request,
        sizes: *mut narsil_keyword_merge_sizes,
    ) -> narsil_status;
    pub fn narsil_write_merge(
        workspace: *mut narsil_workspace,
        request: *const narsil_keyword_merge_request,
        output: *const narsil_keyword_merge_output,
    ) -> narsil_status;
    pub fn narsil_merge_postings(
        workspace: *mut narsil_workspace,
        request: *const narsil_keyword_merge_request,
        output: *const narsil_posting_merge_output,
        count: *mut u32,
    ) -> narsil_status;
    pub fn narsil_measure_field_merge(
        workspace: *mut narsil_workspace,
        request: *const narsil_field_merge_request,
        sizes: *mut narsil_field_merge_sizes,
    ) -> narsil_status;
    pub fn narsil_write_field_merge(
        workspace: *mut narsil_workspace,
        request: *const narsil_field_merge_request,
        output: *const narsil_field_merge_output,
    ) -> narsil_status;
}
