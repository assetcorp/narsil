use std::ffi::{c_char, c_void};

use super::{narsil_status, narsil_workspace};

pub const NARSIL_GRAPH_HEADER_WORDS: usize = 160;
pub const NARSIL_STORE_HEADER_WORDS: usize = 16;
pub const NARSIL_HELD_WORDS_PER_THREAD: usize = 32;
pub const NARSIL_LIST_WORDS_OVER_NEIGHBOURS: usize = 2;

pub const NARSIL_GRAPH_WORD_ENTRY_POINT: usize = 0;
pub const NARSIL_GRAPH_WORD_TOP_LAYER: usize = 1;
pub const NARSIL_GRAPH_WORD_M: usize = 2;
pub const NARSIL_GRAPH_WORD_MMAX0: usize = 3;
pub const NARSIL_GRAPH_WORD_EF_CONSTRUCTION: usize = 4;
pub const NARSIL_GRAPH_WORD_NODE_COUNT: usize = 32;
pub const NARSIL_GRAPH_WORD_TOMBSTONE_COUNT: usize = 33;
pub const NARSIL_GRAPH_WORD_UNLINKED_NODES: usize = 34;
pub const NARSIL_GRAPH_WORD_UPPER_USED: usize = 64;
pub const NARSIL_GRAPH_WORD_SLOTS: usize = 65;
pub const NARSIL_GRAPH_WORD_UPPER_CAPACITY: usize = 66;
pub const NARSIL_GRAPH_WORD_SLOT_CAPACITY: usize = 67;
pub const NARSIL_GRAPH_WORD_LOCK: usize = 96;
pub const NARSIL_GRAPH_WORD_WRITERS_WAITING: usize = 97;
pub const NARSIL_GRAPH_WORD_ENTRY_LOCK: usize = 128;

pub const NARSIL_STORE_WORD_SLOTS: usize = 0;
pub const NARSIL_STORE_WORD_LIVE_COUNT: usize = 1;
pub const NARSIL_STORE_WORD_CALIBRATED: usize = 3;
pub const NARSIL_STORE_WORD_CODE_COUNT: usize = 4;
pub const NARSIL_STORE_WORD_CALIBRATION_GENERATION: usize = 7;

pub const NARSIL_VECTOR_IN_A_BLOCK: i32 = -1;
pub const NARSIL_GRAPH_HELD_ALONE: u32 = u32::MAX;

pub const NARSIL_METRIC_COSINE: u32 = 0;
pub const NARSIL_METRIC_DOT_PRODUCT: u32 = 1;
pub const NARSIL_METRIC_EUCLIDEAN: u32 = 2;

pub type narsil_wake = Option<unsafe extern "C" fn(context: *mut c_void, ordinal: i32)>;

#[repr(C)]
pub struct narsil_graph {
    pub header: *mut i32,
    pub node_levels: *mut u8,
    pub level0: *mut i32,
    pub upper_base: *mut i32,
    pub upper: *mut i32,
    pub locks: *mut i32,
    pub tombstones: *mut u8,
    pub incoming: *mut i32,
    pub nearest_link_due: *mut u8,
    pub held_locks: *mut i32,
    pub thread_slots: u32,
    pub wake: narsil_wake,
    pub wake_context: *mut c_void,
}

#[repr(C)]
pub struct narsil_vector_file {
    pub bytes: *const u8,
    pub length: u64,
    pub mapping: *mut c_void,
}

#[repr(C)]
pub struct narsil_store {
    pub header: *mut i32,
    pub dimension: u32,
    pub bits: u32,
    pub code_blocks: *const *mut u8,
    pub code_block_count: u32,
    pub records_per_block: u32,
    pub code_present: *mut u8,
    pub centroid: *mut f32,
    pub vector_blocks: *const *const f32,
    pub vector_block_count: u32,
    pub vectors_per_block: u32,
    pub vector_stride_floats: u32,
    pub magnitudes: *const f64,
    pub present: *const u8,
    pub vector_file: *const i32,
    pub vector_offset: *const u32,
    pub files: *const narsil_vector_file,
    pub file_count: u32,
}

#[repr(C)]
pub struct narsil_candidates {
    pub ordinals: *mut i32,
    pub distances: *mut f64,
    pub capacity: u32,
    pub count: u32,
}

#[repr(C)]
pub struct narsil_ordinal_set {
    pub bits: *const u8,
    pub bytes: u32,
}

#[repr(C)]
pub struct narsil_search_request {
    pub query: *const f32,
    pub metric: u32,
    pub candidate_count: u32,
    pub thread_slot: u32,
    pub accepted: narsil_ordinal_set,
}

#[repr(C)]
pub struct narsil_score_request {
    pub query: *const f32,
    pub metric: u32,
    pub ordinals: *const i32,
    pub count: u32,
}

#[repr(C)]
pub struct narsil_place_request {
    pub metric: u32,
    pub ordinal: i32,
    pub top_layer: i32,
    pub thread_slot: u32,
    pub graph_held_alone: u32,
}

#[repr(C)]
pub struct narsil_remove_request {
    pub ordinal: i32,
    pub thread_slot: u32,
}

#[repr(C)]
pub struct narsil_compact_request {
    pub metric: u32,
    pub thread_slot: u32,
}

#[repr(C)]
pub struct narsil_connect_request {
    pub metric: u32,
    pub thread_slot: u32,
    pub nearby: *const i32,
    pub nearby_count: u32,
}

#[repr(C)]
pub struct narsil_ordinals_request {
    pub metric: u32,
    pub ordinals: *const i32,
    pub count: u32,
}

unsafe extern "C" {
    pub fn narsil_record_bytes(dimension: u32, bits: u32) -> u32;
    pub fn narsil_vector_file_map(
        path: *const c_char,
        file: *mut narsil_vector_file,
    ) -> narsil_status;
    pub fn narsil_vector_file_unmap(file: *mut narsil_vector_file);
    pub fn narsil_search(
        workspace: *mut narsil_workspace,
        graph: *const narsil_graph,
        store: *const narsil_store,
        request: *const narsil_search_request,
        nearest: *mut narsil_candidates,
    ) -> narsil_status;
    pub fn narsil_score(
        workspace: *mut narsil_workspace,
        store: *const narsil_store,
        request: *const narsil_score_request,
        distances: *mut f64,
    ) -> narsil_status;
    pub fn narsil_place(
        workspace: *mut narsil_workspace,
        graph: *const narsil_graph,
        store: *const narsil_store,
        request: *const narsil_place_request,
    ) -> narsil_status;
    pub fn narsil_remove(
        graph: *const narsil_graph,
        request: *const narsil_remove_request,
    ) -> narsil_status;
    pub fn narsil_compact(
        workspace: *mut narsil_workspace,
        graph: *const narsil_graph,
        store: *const narsil_store,
        request: *const narsil_compact_request,
    ) -> narsil_status;
    pub fn narsil_connect_unreached(
        workspace: *mut narsil_workspace,
        graph: *const narsil_graph,
        store: *const narsil_store,
        request: *const narsil_connect_request,
    ) -> narsil_status;
    pub fn narsil_quantise(
        workspace: *mut narsil_workspace,
        store: *const narsil_store,
        request: *const narsil_ordinals_request,
    ) -> narsil_status;
    pub fn narsil_measure(
        workspace: *mut narsil_workspace,
        store: *const narsil_store,
        request: *const narsil_ordinals_request,
        totals: *mut f64,
    ) -> narsil_status;
}
