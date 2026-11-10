use std::ffi::c_int;

use super::{
    narsil_frozen_segment, narsil_frozen_segment_state, narsil_growing_segment, narsil_status,
    narsil_work_meter, narsil_workspace,
};

pub const NARSIL_SUGGESTION_TOKEN: usize = 0;
pub const NARSIL_SUGGESTION_WORDS: usize = 3;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_expansion_segment {
    pub growing: *const narsil_growing_segment,
    pub frozen: *const narsil_frozen_segment,
    pub state: *const narsil_frozen_segment_state,
    pub occurrences: *const f64,
    pub occurrence_count: usize,
}

#[repr(C)]
pub struct narsil_prefix_request {
    pub segments: *const narsil_expansion_segment,
    pub segment_count: usize,
    pub typed: *const u16,
    pub typed_length: usize,
    pub stemmed: *const u16,
    pub stemmed_length: usize,
    pub own: *const u16,
    pub own_length: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_expansion_output {
    pub segments: *mut u32,
    pub segment_capacity: usize,
    pub tokens: *mut u32,
    pub token_capacity: usize,
    pub factors: *mut f64,
    pub factor_capacity: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_frozen_runs {
    pub points: *const u32,
    pub point_count: usize,
    pub offsets: *const u32,
    pub offset_count: usize,
    pub members: *const u32,
    pub member_count: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_partial_word {
    pub written: *const u16,
    pub written_length: usize,
    pub own: *const u16,
    pub own_length: usize,
    pub tolerance: u32,
    pub prefix_length: u32,
}

#[repr(C)]
pub struct narsil_partial_request {
    pub segments: *const narsil_expansion_segment,
    pub runs: *const narsil_frozen_runs,
    pub segment_count: usize,
    pub words: *const narsil_partial_word,
    pub word_count: usize,
}

#[repr(C)]
pub struct narsil_partial_output {
    pub additions: narsil_expansion_output,
    pub starts: *mut u32,
    pub start_capacity: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_phrase_postings {
    pub documents: *const u32,
    pub fields: *const u16,
    pub position_starts: *const u32,
    pub position_counts: *const u32,
    pub count: usize,
    pub positions: *const u32,
    pub position_count: usize,
    pub ordered: c_int,
}

#[repr(C)]
pub struct narsil_phrase_request {
    pub postings: *const narsil_phrase_postings,
    pub token_count: usize,
    pub starts: *const u32,
    pub phrase_count: usize,
    pub tokens: *const u32,
    pub offsets: *const u32,
    pub entry_count: usize,
    pub searchable: *const u8,
    pub field_count: u32,
    pub filter: *const u32,
    pub filter_words: usize,
    pub removed: *const u32,
    pub removed_words: usize,
    pub ordinal_count: u32,
    pub collect: c_int,
    pub meter: narsil_work_meter,
}

#[repr(C)]
pub struct narsil_phrase_output {
    pub matched: *mut u32,
    pub matched_words: usize,
    pub starts: *mut u32,
    pub start_capacity: usize,
    pub documents: *mut u32,
    pub fields: *mut u16,
    pub frequencies: *mut u32,
    pub document_capacity: usize,
    pub field_capacity: usize,
    pub frequency_capacity: usize,
}

#[repr(C)]
pub struct narsil_synonym_table {
    pub tokens: *const u8,
    pub token_bytes: usize,
    pub offsets: *const u32,
    pub token_count: usize,
    pub rule_start: *const u32,
    pub rule_source: *const i32,
    pub rule_count: usize,
    pub rule_tokens: *const u32,
    pub rule_token_count: usize,
    pub token_start: *const u32,
    pub token_rules: *const u32,
    pub token_rule_count: usize,
}

#[repr(C)]
pub struct narsil_synonym_request {
    pub table: *const narsil_synonym_table,
    pub units: *const u16,
    pub unit_count: usize,
    pub starts: *const u32,
    pub query_count: usize,
}

#[repr(C)]
pub struct narsil_synonym_output {
    pub queries: *mut u32,
    pub query_capacity: usize,
    pub starts: *mut u32,
    pub start_capacity: usize,
    pub tokens: *mut u32,
    pub token_capacity: usize,
}

#[repr(C)]
pub struct narsil_suggestion_request {
    pub segments: *const narsil_expansion_segment,
    pub segment_count: usize,
    pub typed: *const u16,
    pub typed_length: usize,
    pub stemmed: *const u16,
    pub stemmed_length: usize,
    pub limit: u32,
}

#[repr(C)]
pub struct narsil_suggestion_output {
    pub terms: *mut u32,
    pub term_words: usize,
    pub starts: *mut u32,
    pub start_capacity: usize,
    pub spellings: *mut u32,
    pub spelling_words: usize,
    pub occurrences: *mut f64,
    pub occurrence_capacity: usize,
}

unsafe extern "C" {
    pub fn narsil_expand_prefix(
        workspace: *mut narsil_workspace,
        request: *const narsil_prefix_request,
        output: *const narsil_expansion_output,
        count: *mut u32,
    ) -> narsil_status;
    pub fn narsil_expand_partial_words(
        workspace: *mut narsil_workspace,
        request: *const narsil_partial_request,
        output: *const narsil_partial_output,
        count: *mut u32,
    ) -> narsil_status;
    pub fn narsil_match_phrases(
        workspace: *mut narsil_workspace,
        request: *const narsil_phrase_request,
        output: *const narsil_phrase_output,
        row_count: *mut u32,
    ) -> narsil_status;
    pub fn narsil_expand_synonyms(
        request: *const narsil_synonym_request,
        output: *const narsil_synonym_output,
        count: *mut u32,
    ) -> narsil_status;
    pub fn narsil_suggest_terms(
        workspace: *mut narsil_workspace,
        request: *const narsil_suggestion_request,
        output: *const narsil_suggestion_output,
        count: *mut u32,
    ) -> narsil_status;
}
