#![allow(non_camel_case_types)]

mod analysis;
mod expansion;
mod fields;
mod frozen;
mod keyword;
pub(crate) mod layout;
mod math;
mod merge;
mod paged;
mod results;
mod segments;
mod vector;

pub use analysis::*;
pub use expansion::*;
pub use fields::*;
pub use frozen::*;
pub use keyword::*;
pub use math::*;
pub use merge::*;
pub use paged::*;
pub use results::*;
pub use segments::*;
pub use vector::*;

use std::ffi::c_int;

pub type narsil_status = c_int;
pub const NARSIL_OK: narsil_status = 0;
pub const NARSIL_INVALID_ARGUMENT: narsil_status = 1;
pub const NARSIL_OUT_OF_MEMORY: narsil_status = 2;
pub const NARSIL_NEEDS_ROOM: narsil_status = 3;
pub const NARSIL_GRAPH_NOT_HELD_ALONE: narsil_status = 4;
pub const NARSIL_FILE_UNREADABLE: narsil_status = 5;
pub const NARSIL_WORK_CAP_EXCEEDED: narsil_status = 6;
pub const NARSIL_SEGMENT_FULL: narsil_status = 8;
pub const NARSIL_PAGE_CORRUPT: narsil_status = 9;
pub const NARSIL_PAGE_UNREADABLE: narsil_status = 10;
pub const NARSIL_PAGE_INVALID: narsil_status = 11;

pub const NARSIL_CORE_ABI_VERSION: i32 = 50;

const fn decimal(text: &str) -> i32 {
    let digits = text.as_bytes();
    let mut value = 0;
    let mut at = 0;
    while at < digits.len() {
        value = value * 10 + (digits[at] - b'0') as i32;
        at += 1;
    }
    value
}

const _: () = assert!(
    decimal(env!("NARSIL_CORE_HEADER_ABI_VERSION")) == NARSIL_CORE_ABI_VERSION,
    "the Rust bindings describe another ABI version of the Narsil core than narsil_core.h declares"
);

#[repr(C)]
pub struct narsil_workspace {
    _private: [u8; 0],
}

unsafe extern "C" {
    pub fn narsil_core_abi_version() -> i32;
    pub fn narsil_workspace_create(workspace: *mut *mut narsil_workspace) -> narsil_status;
    pub fn narsil_workspace_destroy(workspace: *mut narsil_workspace);
    pub fn narsil_workspace_bytes(workspace: *const narsil_workspace) -> usize;
}
