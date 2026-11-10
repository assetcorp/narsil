use std::ffi::c_int;

use super::narsil_status;

pub const NARSIL_MATH_LOG: c_int = 0;
pub const NARSIL_MATH_SIN: c_int = 1;
pub const NARSIL_MATH_COS: c_int = 2;
pub const NARSIL_MATH_TAN: c_int = 3;
pub const NARSIL_MATH_ASIN: c_int = 4;
pub const NARSIL_MATH_ATAN: c_int = 5;
pub const NARSIL_MATH_ATAN2: c_int = 6;

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
