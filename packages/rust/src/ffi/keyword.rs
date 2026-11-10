use std::ffi::c_int;

use super::{narsil_status, narsil_workspace};

pub const NARSIL_KEYWORD_TERM_SLOT: u32 = 0;
pub const NARSIL_KEYWORD_GROUP_SLOT: u32 = 1;
pub const NARSIL_KEYWORD_PHRASE_SLOT: u32 = 2;
pub const NARSIL_KEYWORD_SLOT_STRIDE: usize = 4;
pub const NARSIL_KEYWORD_LIST_STRIDE: usize = 3;
pub const NARSIL_KEYWORD_LIST_FROM_ROWS: u32 = 1;
pub const NARSIL_KEYWORD_LIST_ORDERED: u32 = 2;
pub const NARSIL_KEYWORD_LIST_VALUE_STRIDE: usize = 2;
pub const NARSIL_KEYWORD_FIELD_NUMBER_COLUMNS: usize = 4;
pub const NARSIL_KEYWORD_NO_LIMIT: f64 = -1.0;

#[repr(C)]
pub struct narsil_keyword_column {
    pub values: *const u32,
    pub length: u32,
}

#[repr(C)]
pub struct narsil_keyword_request {
    pub pool_doc_ids: *const u32,
    pub pool_frequencies: *const u16,
    pub pool_fields: *const u16,
    pub pool_length: u32,
    pub row_doc_ids: *const u32,
    pub row_frequencies: *const f64,
    pub row_fields: *const u16,
    pub row_length: u32,
    pub slots: *const u32,
    pub slot_count: u32,
    pub slot_capacity: u32,
    pub lists: *const u32,
    pub list_values: *const f64,
    pub list_capacity: u32,
    pub slot_values: *const f64,
    pub slot_value_capacity: u32,
    pub field_count: u32,
    pub searchable: *const u8,
    pub partial_marks: *const u8,
    pub name_ranks: *const u16,
    pub field_numbers: *const f64,
    pub lengths: *const narsil_keyword_column,
    pub has_filter: c_int,
    pub filter: *const u32,
    pub filter_words: u32,
    pub live: *const u32,
    pub live_words: u32,
    pub removed: *const u32,
    pub removed_words: u32,
    pub terms: f64,
    pub capacity: u32,
    pub total_documents: f64,
    pub term_match: f64,
    pub limit: f64,
    pub min_score: f64,
    pub collect: c_int,
}

#[repr(C)]
pub struct narsil_keyword_output {
    pub ordinals: *mut i32,
    pub scores: *mut f64,
    pub length: u32,
    pub matched: *mut u32,
    pub matched_words: u32,
    pub count: u32,
    pub total_matched: u32,
    pub scoring_path: u32,
}

unsafe extern "C" {
    pub fn narsil_keyword_score(
        workspace: *mut narsil_workspace,
        request: *const narsil_keyword_request,
        output: *mut narsil_keyword_output,
    ) -> narsil_status;
}
