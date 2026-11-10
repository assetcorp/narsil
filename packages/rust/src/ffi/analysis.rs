use std::ffi::c_char;

use super::narsil_status;

pub const NARSIL_ANALYSE_STEM: u32 = 1 << 0;
pub const NARSIL_ANALYSE_REMOVE_STOP_WORDS: u32 = 1 << 1;
pub const NARSIL_ANALYSE_REMOVE_DIACRITICS: u32 = 1 << 2;
pub const NARSIL_ANALYSE_COLLECT_SURFACES: u32 = 1 << 3;
pub const NARSIL_ANALYSE_SPELLINGS: u32 = 1 << 4;
pub const NARSIL_NO_SURFACE: u32 = u32::MAX;
pub const NARSIL_NO_TERM_SLOT: u32 = u32::MAX;
pub const NARSIL_MAX_ANALYSED_UNITS: u32 = 1 << 30;

#[repr(C)]
pub struct narsil_analyser {
    _private: [u8; 0],
}

#[repr(C)]
pub struct narsil_stop_word_set {
    _private: [u8; 0],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_token {
    pub position: u32,
    pub term_offset: u32,
    pub term_length: u32,
    pub surface_offset: u32,
    pub surface_length: u32,
    pub original_offset: u32,
    pub original_length: u32,
    pub term_slot: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct narsil_tokens {
    pub tokens: *const narsil_token,
    pub token_count: u32,
    pub units: *const u16,
    pub unit_count: u32,
}

#[repr(C)]
pub struct narsil_analysis_request {
    pub language: u32,
    pub stop_words: *const narsil_stop_word_set,
    pub flags: u32,
    pub text: *const u16,
    pub length: u32,
}

#[repr(C)]
pub struct narsil_term {
    pub units: *const u16,
    pub length: u32,
}

#[repr(C)]
pub struct narsil_word_list {
    pub units: *const u16,
    pub offsets: *const u32,
    pub count: u32,
}

unsafe extern "C" {
    pub fn narsil_language_count() -> u32;
    pub fn narsil_language_lookup(
        name: *const c_char,
        length: usize,
        language: *mut u32,
    ) -> narsil_status;
    pub fn narsil_language_name(language: u32) -> *const c_char;
    pub fn narsil_language_revision(language: u32) -> *const c_char;
    pub fn narsil_analyser_create(analyser: *mut *mut narsil_analyser) -> narsil_status;
    pub fn narsil_analyser_destroy(analyser: *mut narsil_analyser);
    pub fn narsil_stop_word_set_create(
        units: *const u16,
        offsets: *const u32,
        count: u32,
        set: *mut *mut narsil_stop_word_set,
    ) -> narsil_status;
    pub fn narsil_stop_word_set_destroy(set: *mut narsil_stop_word_set);
    pub fn narsil_analyse(
        analyser: *mut narsil_analyser,
        request: *const narsil_analysis_request,
        tokens: *mut narsil_tokens,
    ) -> narsil_status;
    pub fn narsil_transform(
        analyser: *mut narsil_analyser,
        request: *const narsil_analysis_request,
        term: *mut narsil_term,
    ) -> narsil_status;
    pub fn narsil_language_stop_words(language: u32, words: *mut narsil_word_list)
    -> narsil_status;
}
