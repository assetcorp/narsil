use super::{
    narsil_analyser, narsil_expansion_output, narsil_expansion_segment, narsil_partial_output,
    narsil_partial_request, narsil_prefix_request, narsil_status, narsil_term, narsil_workspace,
};

pub const NARSIL_FOLD_STEM: u32 = 1 << 0;

#[repr(C)]
pub struct narsil_fold_table {
    _private: [u8; 0],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_folded_word {
    pub key: *const u16,
    pub key_length: usize,
    pub own: *const u16,
    pub own_length: usize,
    pub excluded: *const narsil_term,
    pub excluded_count: usize,
    pub tolerance: u32,
    pub prefix_length: u32,
}

#[repr(C)]
pub struct narsil_folded_request {
    pub segments: *const narsil_expansion_segment,
    pub tables: *const *const narsil_fold_table,
    pub segment_count: usize,
    pub words: *const narsil_folded_word,
    pub word_count: usize,
}

#[repr(C)]
pub struct narsil_folded_output {
    pub segments: *mut u32,
    pub segment_capacity: usize,
    pub tokens: *mut u32,
    pub token_capacity: usize,
    pub starts: *mut u32,
    pub start_capacity: usize,
}

#[repr(C)]
pub struct narsil_folded_prefix_request {
    pub prefix: narsil_prefix_request,
    pub tables: *const *const narsil_fold_table,
    pub folded: *const u16,
    pub folded_length: usize,
}

#[repr(C)]
pub struct narsil_folded_partial_request {
    pub partial: narsil_partial_request,
    pub tables: *const *const narsil_fold_table,
    pub folded: *const narsil_term,
}

unsafe extern "C" {
    pub fn narsil_language_folds(language: u32, folds: *mut u32) -> narsil_status;
    pub fn narsil_fold_spelling(
        analyser: *mut narsil_analyser,
        language: u32,
        units: *const u16,
        length: u32,
        flags: u32,
        term: *mut narsil_term,
    ) -> narsil_status;
    pub fn narsil_fold_table_create(table: *mut *mut narsil_fold_table) -> narsil_status;
    pub fn narsil_fold_table_destroy(table: *mut narsil_fold_table);
    pub fn narsil_fold_table_current(
        table: *const narsil_fold_table,
        segment: *const narsil_expansion_segment,
        language: u32,
    ) -> std::ffi::c_int;
    pub fn narsil_fold_table_update(
        workspace: *mut narsil_workspace,
        analyser: *mut narsil_analyser,
        table: *mut narsil_fold_table,
        segment: *const narsil_expansion_segment,
        language: u32,
    ) -> narsil_status;
    pub fn narsil_expand_folded_terms(
        workspace: *mut narsil_workspace,
        request: *const narsil_folded_request,
        output: *const narsil_folded_output,
        count: *mut u32,
    ) -> narsil_status;
    pub fn narsil_expand_folded_prefix(
        workspace: *mut narsil_workspace,
        request: *const narsil_folded_prefix_request,
        output: *const narsil_expansion_output,
        count: *mut u32,
    ) -> narsil_status;
    pub fn narsil_expand_folded_partial_words(
        workspace: *mut narsil_workspace,
        request: *const narsil_folded_partial_request,
        output: *const narsil_partial_output,
        count: *mut u32,
    ) -> narsil_status;
}
