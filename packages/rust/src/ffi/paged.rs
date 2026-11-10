use std::ffi::{c_char, c_int};

use super::{narsil_status, narsil_work_meter, narsil_workspace};

pub const NARSIL_PAGE_SLOT_BYTES: usize = 65536;

#[repr(C)]
pub struct narsil_paged_file {
    _private: [u8; 0],
}

#[repr(C)]
pub struct narsil_page_cache {
    pub bytes: *mut u8,
    pub byte_capacity: usize,
    pub files: *mut u64,
    pub offsets: *mut u64,
    pub pages: *mut u64,
    pub lengths: *mut u32,
    pub checksums: *mut u32,
    pub slots: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_page_section {
    pub file: *const narsil_paged_file,
    pub offset: u64,
    pub length: u64,
    pub page_bytes: u32,
    pub checksums: *const u8,
    pub checksum_bytes: usize,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct narsil_page_fault {
    pub file: u64,
    pub section: u64,
    pub page: u64,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_paged_posting_list {
    pub first: u32,
    pub count: u32,
    pub documents: u32,
    pub fields: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_paged_position_list {
    pub offsets: *const narsil_page_section,
    pub values: *const narsil_page_section,
    pub first: u32,
    pub count: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_paged_position_output {
    pub offsets: *mut u32,
    pub offset_capacity: usize,
    pub values: *mut u32,
    pub value_capacity: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_paged_removal_list {
    pub offsets: *const narsil_page_section,
    pub values: *const narsil_page_section,
    pub ordinal: u32,
    pub token_count: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_paged_removal_output {
    pub values: *mut u32,
    pub capacity: usize,
    pub count: *mut u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_paged_id_request {
    pub offsets: *const narsil_page_section,
    pub values: *const narsil_page_section,
    pub ordinal: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_paged_id_output {
    pub bytes: *mut u8,
    pub capacity: usize,
    pub length: *mut u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_paged_ordinal_request {
    pub position: u32,
    pub documents: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_paged_totals_request {
    pub first: u32,
    pub count: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_paged_write_request {
    pub sequences: *const narsil_page_section,
    pub terms: *const narsil_page_section,
    pub ordinal: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_paged_write_output {
    pub values: *mut u64,
    pub capacity: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_paged_vector_file {
    pub first: u32,
    pub count: u32,
    pub dead: *const u8,
    pub dead_bytes: usize,
    pub vectors: narsil_page_section,
    pub records: *const narsil_page_section,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_paged_graph_part {
    pub first: u32,
    pub count: u32,
    pub levels: *const u8,
    pub level_count: usize,
    pub node_offsets: *const u32,
    pub offset_count: usize,
    pub neighbours: narsil_page_section,
}

#[repr(C)]
pub struct narsil_paged_vector_field {
    pub dimension: u32,
    pub metric: u32,
    pub total: u32,
    pub entry_point: u32,
    pub has_entry_point: c_int,
    pub max_layer: u32,
    pub bits: u32,
    pub centroid: *const f32,
    pub centroid_count: usize,
    pub files: *const narsil_paged_vector_file,
    pub file_count: usize,
    pub parts: *const narsil_paged_graph_part,
    pub part_count: usize,
}

#[repr(C)]
pub struct narsil_paged_vector_request {
    pub query: *const f32,
    pub query_count: usize,
    pub k: u32,
    pub ef: u32,
    pub rescore_depth: u32,
    pub explicit_rescore_window: c_int,
    pub min_similarity: f64,
    pub accepted: *const u32,
    pub accepted_words: usize,
    pub excluded: *const u32,
    pub excluded_words: usize,
    pub meter: narsil_work_meter,
}

#[repr(C)]
pub struct narsil_paged_vector_output {
    pub ordinals: *mut u32,
    pub ordinal_capacity: usize,
    pub scores: *mut f64,
    pub score_capacity: usize,
}

unsafe extern "C" {
    pub fn narsil_paged_file_open(
        path: *const c_char,
        file: *mut *mut narsil_paged_file,
    ) -> narsil_status;
    pub fn narsil_paged_file_close(file: *mut narsil_paged_file);
    pub fn narsil_paged_file_length(file: *const narsil_paged_file) -> u64;
    pub fn narsil_paged_file_identity(file: *const narsil_paged_file) -> u64;
    pub fn narsil_read_page(
        workspace: *mut narsil_workspace,
        cache: *mut narsil_page_cache,
        section: *const narsil_page_section,
        page: u64,
        output: *mut u8,
        output_capacity: usize,
        fault: *mut narsil_page_fault,
    ) -> narsil_status;
    pub fn narsil_read_paged_postings(
        workspace: *mut narsil_workspace,
        cache: *mut narsil_page_cache,
        section: *const narsil_page_section,
        list: narsil_paged_posting_list,
        output: *mut u8,
        output_capacity: usize,
        fault: *mut narsil_page_fault,
    ) -> narsil_status;
    pub fn narsil_read_paged_positions(
        workspace: *mut narsil_workspace,
        cache: *mut narsil_page_cache,
        list: narsil_paged_position_list,
        output: narsil_paged_position_output,
        fault: *mut narsil_page_fault,
    ) -> narsil_status;
    pub fn narsil_read_paged_ordinal(
        workspace: *mut narsil_workspace,
        cache: *mut narsil_page_cache,
        section: *const narsil_page_section,
        request: narsil_paged_ordinal_request,
        output: *mut u32,
        capacity: usize,
        fault: *mut narsil_page_fault,
    ) -> narsil_status;
    pub fn narsil_read_paged_totals(
        workspace: *mut narsil_workspace,
        cache: *mut narsil_page_cache,
        section: *const narsil_page_section,
        request: narsil_paged_totals_request,
        output: *mut f64,
        capacity: usize,
        fault: *mut narsil_page_fault,
    ) -> narsil_status;
    pub fn narsil_read_paged_write_record(
        workspace: *mut narsil_workspace,
        cache: *mut narsil_page_cache,
        request: narsil_paged_write_request,
        output: narsil_paged_write_output,
        fault: *mut narsil_page_fault,
    ) -> narsil_status;
    pub fn narsil_read_paged_removals(
        workspace: *mut narsil_workspace,
        cache: *mut narsil_page_cache,
        list: narsil_paged_removal_list,
        output: narsil_paged_removal_output,
        fault: *mut narsil_page_fault,
    ) -> narsil_status;
    pub fn narsil_read_paged_id(
        workspace: *mut narsil_workspace,
        cache: *mut narsil_page_cache,
        request: narsil_paged_id_request,
        output: narsil_paged_id_output,
        fault: *mut narsil_page_fault,
    ) -> narsil_status;
    pub fn narsil_search_paged_vectors(
        workspace: *mut narsil_workspace,
        cache: *mut narsil_page_cache,
        field: *const narsil_paged_vector_field,
        request: *const narsil_paged_vector_request,
        output: *const narsil_paged_vector_output,
        count: *mut u32,
        fault: *mut narsil_page_fault,
    ) -> narsil_status;
}
