use crate::ffi;

const IDF_HALF_DOCUMENT: f64 = 0.5;

/// Returns the natural logarithm from the native core's fdlibm port, which gives the same bits on every platform.
pub(crate) fn log(value: f64) -> f64 {
    let mut result = f64::NAN;
    let batch = ffi::narsil_math_batch {
        first: &value,
        second: std::ptr::null(),
        results: &mut result,
        count: 1,
    };
    let status = unsafe { ffi::narsil_math_apply(ffi::NARSIL_MATH_LOG, &batch) };
    if status == ffi::NARSIL_OK {
        result
    } else {
        f64::NAN
    }
}

/// Returns the BM25 inverse document frequency of a term that `document_frequency` of `total_documents` hold.
pub(crate) fn idf(document_frequency: f64, total_documents: f64) -> f64 {
    if total_documents == 0.0 {
        return 0.0;
    }
    log((total_documents - document_frequency + IDF_HALF_DOCUMENT)
        / (document_frequency + IDF_HALF_DOCUMENT)
        + 1.0)
}

/// Returns the BM25 score of one term in one field, before the field's boost.
pub(crate) fn bm25(
    term_frequency: f64,
    idf: f64,
    field_length: f64,
    average_length: f64,
    k1: f64,
    b: f64,
) -> f64 {
    if average_length == 0.0 {
        return 0.0;
    }
    let numerator = term_frequency * (k1 + 1.0);
    let denominator = term_frequency + k1 * (1.0 - b + (b * field_length) / average_length);
    if denominator == 0.0 {
        return 0.0;
    }
    idf * (numerator / denominator)
}
