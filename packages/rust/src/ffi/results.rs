use super::{narsil_analyser, narsil_status, narsil_stored_values, narsil_workspace};

pub const NARSIL_FUSION_RRF: u32 = 0;
pub const NARSIL_FUSION_LINEAR: u32 = 1;

#[repr(C)]
pub struct narsil_group_request {
    pub values: *const narsil_stored_values,
    pub value_count: usize,
    pub ordinals: *const u32,
    pub ordinal_count: usize,
    pub scores: *const f64,
    pub score_count: usize,
    pub id_ranks: *const u32,
    pub id_rank_count: usize,
    pub max_per_group: u32,
    pub has_limit: u32,
    pub limit: u32,
}

#[repr(C)]
pub struct narsil_group_output {
    pub heads: *mut u32,
    pub head_capacity: usize,
    pub offsets: *mut u32,
    pub offset_capacity: usize,
    pub hits: *mut u32,
    pub hit_capacity: usize,
    pub members: *mut u32,
    pub member_capacity: usize,
    pub count: u32,
}

#[repr(C)]
pub struct narsil_group_merge_request {
    pub keys: *const u32,
    pub key_count: usize,
    pub offsets: *const u32,
    pub offset_count: usize,
    pub scores: *const f64,
    pub score_count: usize,
    pub score_present: *const u32,
    pub score_present_count: usize,
    pub ranks: *const u32,
    pub rank_count: usize,
    pub id_ranks: *const u32,
    pub id_rank_count: usize,
    pub has_scores: u32,
    pub has_score_present: u32,
    pub sorted: u32,
    pub max_per_group: u32,
    pub has_limit: u32,
    pub limit: u32,
}

#[repr(C)]
pub struct narsil_group_merge_output {
    pub keys: *mut u32,
    pub key_capacity: usize,
    pub offsets: *mut u32,
    pub offset_capacity: usize,
    pub sources: *mut u32,
    pub source_capacity: usize,
    pub indices: *mut u32,
    pub index_capacity: usize,
    pub count: u32,
}

#[repr(C)]
pub struct narsil_pinned_request {
    pub count: u32,
    pub ranked: *const i32,
    pub ranked_count: usize,
    pub positions: *const u32,
    pub position_count: usize,
    pub has_depth: u32,
    pub depth: u32,
}

#[repr(C)]
pub struct narsil_pinned_output {
    pub entries: *mut i32,
    pub capacity: usize,
    pub count: u32,
}

#[repr(C)]
pub struct narsil_page_request {
    pub count: u32,
    pub sorted: u32,
    pub has_scores: u32,
    pub has_anchor_score: u32,
    pub scores: *const f64,
    pub scores_length: usize,
    pub score_present: *const u32,
    pub score_present_length: usize,
    pub after_anchor: *const u32,
    pub after_anchor_length: usize,
    pub anchor_score: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_highlight_text {
    pub units: *const u16,
    pub length: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_highlight_term {
    pub text: narsil_highlight_text,
    pub tolerance: u32,
}

#[repr(C)]
pub struct narsil_highlight_query {
    pub terms: *const narsil_highlight_term,
    pub term_count: usize,
    pub prefix_length: u32,
    pub prefix: narsil_highlight_text,
    pub synonyms: *const narsil_highlight_text,
    pub synonym_count: usize,
    pub partial_words: *const narsil_highlight_text,
    pub partial_count: usize,
}

#[repr(C)]
pub struct narsil_highlight_request {
    pub language: u32,
    pub text: narsil_highlight_text,
    pub query: narsil_highlight_query,
    pub pre_tag: narsil_highlight_text,
    pub post_tag: narsil_highlight_text,
    pub maximum: u32,
}

#[repr(C)]
pub struct narsil_highlight_output {
    pub snippet: *mut u16,
    pub snippet_capacity: usize,
    pub positions: *mut u32,
    pub position_words: usize,
    pub snippet_length: *mut u32,
    pub length_capacity: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_fusion_leg {
    pub keys: *const u32,
    pub scores: *const f64,
    pub count: u32,
}

#[repr(C)]
pub struct narsil_fusion_request {
    pub strategy: u32,
    pub rank_constant: f64,
    pub alpha: f64,
    pub text: narsil_fusion_leg,
    pub vector: narsil_fusion_leg,
    pub id_ranks: *const u32,
    pub key_count: u32,
}

#[repr(C)]
pub struct narsil_fusion_output {
    pub keys: *mut u32,
    pub scores: *mut f64,
    pub capacity: u32,
    pub count: u32,
}

#[repr(C)]
pub struct narsil_merge_request {
    pub offsets: *const u32,
    pub offset_count: usize,
    pub scores: *const f64,
    pub score_count: usize,
    pub ranks: *const u32,
    pub rank_count: usize,
    pub limit: u32,
}

#[repr(C)]
pub struct narsil_merge_output {
    pub lists: *mut u32,
    pub list_capacity: usize,
    pub indices: *mut u32,
    pub index_capacity: usize,
    pub count: u32,
}

#[repr(C)]
pub struct narsil_facet_merge_request {
    pub offsets: *const u32,
    pub offset_count: usize,
    pub values: *const u32,
    pub value_count: usize,
    pub counts: *const u32,
    pub count_count: usize,
    pub bounds: *const u32,
    pub bound_count: usize,
    pub ranks: *const u32,
    pub rank_count: usize,
    pub ascending: u32,
    pub has_limit: u32,
    pub limit: u32,
}

#[repr(C)]
pub struct narsil_facet_merge_output {
    pub values: *mut u32,
    pub value_capacity: usize,
    pub counts: *mut u32,
    pub count_capacity: usize,
    pub bound: *mut u32,
    pub bound_capacity: usize,
    pub count: u32,
}

unsafe extern "C" {
    pub fn narsil_group_hits(
        workspace: *mut narsil_workspace,
        request: *const narsil_group_request,
        output: *mut narsil_group_output,
    ) -> narsil_status;
    pub fn narsil_merge_groups(
        workspace: *mut narsil_workspace,
        request: *const narsil_group_merge_request,
        output: *mut narsil_group_merge_output,
    ) -> narsil_status;
    pub fn narsil_place_pinned(
        workspace: *mut narsil_workspace,
        request: *const narsil_pinned_request,
        output: *mut narsil_pinned_output,
    ) -> narsil_status;
    pub fn narsil_page_start(request: *const narsil_page_request, start: *mut u32)
    -> narsil_status;
    pub fn narsil_highlight(
        analyser: *mut narsil_analyser,
        workspace: *mut narsil_workspace,
        request: *const narsil_highlight_request,
        output: *const narsil_highlight_output,
        count: *mut u32,
    ) -> narsil_status;
    pub fn narsil_fuse(
        workspace: *mut narsil_workspace,
        request: *const narsil_fusion_request,
        output: *mut narsil_fusion_output,
    ) -> narsil_status;
    pub fn narsil_merge_rankings(
        workspace: *mut narsil_workspace,
        request: *const narsil_merge_request,
        output: *mut narsil_merge_output,
    ) -> narsil_status;
    pub fn narsil_merge_sorted(
        workspace: *mut narsil_workspace,
        request: *const narsil_merge_request,
        output: *mut narsil_merge_output,
    ) -> narsil_status;
    pub fn narsil_merge_facets(
        workspace: *mut narsil_workspace,
        request: *const narsil_facet_merge_request,
        output: *mut narsil_facet_merge_output,
    ) -> narsil_status;
}
