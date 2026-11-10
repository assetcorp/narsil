use std::ffi::c_int;

use crate::ffi;

fn apply(function: c_int, first: f64, second: Option<f64>) -> f64 {
    let mut result = f64::NAN;
    let second_value = second.unwrap_or(0.0);
    let batch = ffi::narsil_math_batch {
        first: &first,
        second: if second.is_some() {
            &second_value
        } else {
            std::ptr::null()
        },
        results: &mut result,
        count: 1,
    };
    let status = unsafe { ffi::narsil_math_apply(function, &batch) };
    if status == ffi::NARSIL_OK {
        result
    } else {
        f64::NAN
    }
}

pub(crate) fn sin(value: f64) -> f64 {
    apply(ffi::NARSIL_MATH_SIN, value, None)
}

pub(crate) fn cos(value: f64) -> f64 {
    apply(ffi::NARSIL_MATH_COS, value, None)
}

pub(crate) fn tan(value: f64) -> f64 {
    apply(ffi::NARSIL_MATH_TAN, value, None)
}

pub(crate) fn asin(value: f64) -> f64 {
    apply(ffi::NARSIL_MATH_ASIN, value, None)
}

pub(crate) fn atan(value: f64) -> f64 {
    apply(ffi::NARSIL_MATH_ATAN, value, None)
}

pub(crate) fn atan2(y: f64, x: f64) -> f64 {
    apply(ffi::NARSIL_MATH_ATAN2, y, Some(x))
}
