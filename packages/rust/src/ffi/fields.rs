use std::ffi::c_void;

use super::{narsil_status, narsil_work_meter, narsil_workspace};

pub const NARSIL_FILTER_TEST: u32 = 0;
pub const NARSIL_FILTER_AND: u32 = 1;
pub const NARSIL_FILTER_OR: u32 = 2;
pub const NARSIL_FILTER_NOT: u32 = 3;
pub const NARSIL_FILTER_ANDNOT: u32 = 4;
pub const NARSIL_FILTER_PRESENT: u32 = 5;
pub const NARSIL_FILTER_BITSET: u32 = 6;

pub const NARSIL_FILTER_ABSENT: u32 = 0;
pub const NARSIL_FILTER_NUMERIC: u32 = 1;
pub const NARSIL_FILTER_BOOLEAN: u32 = 2;
pub const NARSIL_FILTER_ENUM: u32 = 3;
pub const NARSIL_FILTER_GEO: u32 = 4;

pub const NARSIL_FILTER_EQ: u32 = 0;
pub const NARSIL_FILTER_GT: u32 = 1;
pub const NARSIL_FILTER_GTE: u32 = 2;
pub const NARSIL_FILTER_LT: u32 = 3;
pub const NARSIL_FILTER_LTE: u32 = 4;
pub const NARSIL_FILTER_BETWEEN: u32 = 5;
pub const NARSIL_FILTER_ANY: u32 = 6;
pub const NARSIL_FILTER_ALL: u32 = 7;
pub const NARSIL_FILTER_PREFIX: u32 = 8;
pub const NARSIL_FILTER_SUFFIX: u32 = 9;
pub const NARSIL_FILTER_RADIUS: u32 = 10;
pub const NARSIL_FILTER_POLYGON: u32 = 11;
pub const NARSIL_FILTER_FIELD_REGIONS: usize = 6;

pub const NARSIL_PATTERN_EQ: u32 = 0;
pub const NARSIL_PATTERN_STARTS_WITH: u32 = 1;
pub const NARSIL_PATTERN_ENDS_WITH: u32 = 2;
pub const NARSIL_PATTERN_CONTAINS: u32 = 3;
pub const NARSIL_PATTERN_WILDCARD: u32 = 4;
pub const NARSIL_PATTERN_REGEX: u32 = 5;

pub const NARSIL_SORT_MIN: u32 = 0;
pub const NARSIL_SORT_MAX: u32 = 1;
pub const NARSIL_SORT_AVG: u32 = 2;
pub const NARSIL_SORT_MEDIAN: u32 = 3;
pub const NARSIL_SORT_MISSING: u32 = 0;
pub const NARSIL_SORT_NUMBER: u32 = 1;
pub const NARSIL_SORT_STRING: u32 = 2;
pub const NARSIL_SORT_FALSE: u32 = 3;
pub const NARSIL_SORT_TRUE: u32 = 4;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_stored_values {
    pub shapes: *const u8,
    pub shape_count: usize,
    pub starts: *const u32,
    pub start_count: usize,
    pub kinds: *const u8,
    pub kind_count: usize,
    pub numbers: *const f64,
    pub number_count: usize,
    pub text_start: *const u32,
    pub text_start_count: usize,
    pub text_length: *const u32,
    pub text_length_count: usize,
    pub units: *const u16,
    pub unit_count: usize,
    pub bytes: *const u8,
    pub byte_count: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_filter_region {
    pub data: *const c_void,
    pub length: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_filter_field {
    pub kind: u32,
    pub region_count: usize,
    pub regions: [narsil_filter_region; NARSIL_FILTER_FIELD_REGIONS],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_filter_bits {
    pub words: *const u32,
    pub count: usize,
}

#[repr(C)]
pub struct narsil_filter_program {
    pub plan: *const u32,
    pub plan_words: usize,
    pub numbers: *const f64,
    pub number_count: usize,
    pub units: *const u16,
    pub unit_count: usize,
    pub offsets: *const u32,
    pub offset_count: usize,
    pub lists: *const u32,
    pub list_words: usize,
    pub bitsets: *const narsil_filter_bits,
    pub bitset_count: usize,
    pub fields: *const narsil_filter_field,
    pub field_count: usize,
    pub live: narsil_filter_bits,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_pattern_list {
    pub values: *const u32,
    pub count: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_pattern_index {
    pub documents: narsil_pattern_list,
    pub runs: narsil_pattern_list,
    pub offsets: narsil_pattern_list,
    pub postings: narsil_pattern_list,
}

#[repr(C)]
pub struct narsil_pattern_test {
    pub text: *const u16,
    pub length: usize,
    pub operator_kind: u32,
    pub case_fold: u32,
    pub tolerance: u32,
    pub count_preparation: u32,
    pub matcher_bytes: u32,
}

#[repr(C)]
pub struct narsil_boolean_index {
    pub true_bits: *const u32,
    pub true_words: usize,
    pub false_bits: *const u32,
    pub false_words: usize,
}

#[repr(C)]
pub struct narsil_numeric_facet_input {
    pub values: *const f64,
    pub count: usize,
    pub ordinals: *const u32,
    pub ordinal_count: usize,
    pub matched: *const u32,
    pub matched_words: usize,
}

#[repr(C)]
pub struct narsil_number_facet_output {
    pub values: *mut f64,
    pub value_capacity: usize,
    pub counts: *mut u32,
    pub count_capacity: usize,
}

#[repr(C)]
pub struct narsil_value_facet_output {
    pub values: *mut u32,
    pub value_capacity: usize,
    pub counts: *mut u32,
    pub count_capacity: usize,
}

#[repr(C)]
pub struct narsil_sort_value_output {
    pub number: *mut f64,
    pub number_capacity: usize,
    pub text: *mut u32,
    pub text_capacity: usize,
    pub kind: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_sort_values {
    pub kinds: *const u8,
    pub count: usize,
    pub numbers: *const f64,
    pub number_count: usize,
    pub text_start: *const u32,
    pub text_start_count: usize,
    pub text_length: *const u32,
    pub text_length_count: usize,
    pub units: *const u16,
    pub unit_count: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_sort_values_output {
    pub kinds: *mut u8,
    pub capacity: usize,
    pub numbers: *mut f64,
    pub number_capacity: usize,
    pub text_start: *mut u32,
    pub text_start_capacity: usize,
    pub text_length: *mut u32,
    pub text_length_capacity: usize,
    pub units: *mut u16,
    pub unit_capacity: usize,
}

#[repr(C)]
pub struct narsil_sort_order_output {
    pub values: narsil_sort_values_output,
    pub ranks: *mut i32,
    pub rank_capacity: usize,
    pub ordered: *mut u32,
    pub ordered_capacity: usize,
    pub dirty: *mut u32,
    pub dirty_capacity: usize,
    pub counts: *mut u32,
    pub count_capacity: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_sort_column {
    pub current: narsil_sort_values,
    pub values: narsil_sort_values,
    pub ranks: *const i32,
    pub rank_count: usize,
    pub ordered: *const u32,
    pub ordered_count: usize,
    pub dirty: *const u32,
    pub dirty_words: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_sort_bound {
    pub units: *const u16,
    pub length: usize,
    pub present: u32,
    pub inclusive: u32,
}

#[repr(C)]
pub struct narsil_text_range_request {
    pub lower: narsil_sort_bound,
    pub upper: narsil_sort_bound,
    pub live: *const u32,
    pub live_words: usize,
    pub output: *mut u32,
    pub output_words: usize,
}

#[repr(C)]
pub struct narsil_sort_select_request {
    pub columns: *const narsil_sort_column,
    pub column_count: usize,
    pub directions: *const u8,
    pub direction_count: usize,
    pub filter: *const u32,
    pub filter_words: usize,
    pub live: *const u32,
    pub live_words: usize,
    pub limit: u32,
    pub anchor_ranks: *const i32,
    pub anchor_rank_count: usize,
    pub anchor_values: *const narsil_sort_values,
    pub output: *mut u32,
    pub output_capacity: usize,
}

unsafe extern "C" {
    pub fn narsil_evaluate_filter(
        workspace: *mut narsil_workspace,
        program: *const narsil_filter_program,
        into: *mut u32,
        into_words: usize,
    ) -> narsil_status;
    pub fn narsil_pattern_match(
        workspace: *mut narsil_workspace,
        index: *const narsil_pattern_index,
        values: *const narsil_stored_values,
        test: *const narsil_pattern_test,
        meter: *const narsil_work_meter,
        into: *mut u32,
        into_words: usize,
    ) -> narsil_status;
    pub fn narsil_stored_range_facet(
        values: *const narsil_stored_values,
        matched: *const u32,
        matched_words: usize,
        ranges: *const f64,
        range_length: usize,
        counts: *mut u32,
        count_capacity: usize,
    ) -> narsil_status;
    pub fn narsil_value_facet(
        workspace: *mut narsil_workspace,
        values: *const narsil_stored_values,
        matched: *const u32,
        matched_words: usize,
        output: *const narsil_value_facet_output,
        count: *mut u32,
    ) -> narsil_status;
    pub fn narsil_enum_facet(
        workspace: *mut narsil_workspace,
        offsets: *const u32,
        offset_count: usize,
        postings: *const u32,
        posting_count: usize,
        matched: *const u32,
        matched_words: usize,
        counts: *mut u32,
        count_capacity: usize,
    ) -> narsil_status;
    pub fn narsil_number_facet(
        workspace: *mut narsil_workspace,
        input: *const narsil_numeric_facet_input,
        output: *const narsil_number_facet_output,
        count: *mut u32,
    ) -> narsil_status;
    pub fn narsil_range_facet(
        workspace: *mut narsil_workspace,
        input: *const narsil_numeric_facet_input,
        ranges: *const f64,
        range_length: usize,
        counts: *mut u32,
        count_capacity: usize,
    ) -> narsil_status;
    pub fn narsil_boolean_facet(
        index: *const narsil_boolean_index,
        matched: *const u32,
        matched_words: usize,
        counts: *mut u32,
        count_capacity: usize,
    ) -> narsil_status;
    pub fn narsil_sort_value(
        workspace: *mut narsil_workspace,
        values: *const narsil_stored_values,
        ordinal: u32,
        mode: u32,
        output: *mut narsil_sort_value_output,
    ) -> narsil_status;
    pub fn narsil_text_range(
        column: *const narsil_sort_column,
        request: *const narsil_text_range_request,
    ) -> narsil_status;
    pub fn narsil_build_sort_order(
        workspace: *mut narsil_workspace,
        current: *const narsil_sort_values,
        live: *const u32,
        live_words: usize,
        output: *mut narsil_sort_order_output,
    ) -> narsil_status;
    pub fn narsil_sort_select(
        workspace: *mut narsil_workspace,
        request: *const narsil_sort_select_request,
        count: *mut u32,
    ) -> narsil_status;
}
