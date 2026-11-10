use std::ffi::c_int;

use super::narsil_status;

pub const NARSIL_MATH_LOG: c_int = 0;

#[repr(C)]
pub struct narsil_math_batch {
    pub first: *const f64,
    pub second: *const f64,
    pub results: *mut f64,
    pub count: usize,
}

unsafe extern "C" {
    pub fn narsil_math_apply(function: c_int, batch: *const narsil_math_batch) -> narsil_status;
}
