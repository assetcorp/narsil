use std::ptr;

use crate::error::Result;
use crate::ffi;
use crate::index::paged::paged_read;
use crate::keyword::workspace::core_refused;
use crate::pattern::WorkMeter;

use super::super::core::core_failed;
use super::super::graph_search::depths_for;
use super::super::ranking::VectorHit;
use super::super::search::VectorSearchOptions;
use super::super::settings::metric_code;
use super::field::ColdField;
use super::scan::ranked_by_id;

const NUMBERS_PER_MASK_WORD: usize = 32;

pub(super) struct GraphWalk<'a> {
    pub(super) field: &'a ColdField,
    pub(super) query: &'a [f32],
    pub(super) options: &'a VectorSearchOptions,
    pub(super) k: usize,
    pub(super) accepted: Option<&'a [u32]>,
    pub(super) excluded: &'a [u32],
}

fn mask_of(total: u32, numbers: &[u32]) -> Vec<u32> {
    let words = (total as usize).div_ceil(NUMBERS_PER_MASK_WORD).max(1);
    let mut mask = vec![0u32; words];
    for &number in numbers.iter().filter(|&&number| number < total) {
        mask[number as usize / NUMBERS_PER_MASK_WORD] |=
            1 << (number as usize % NUMBERS_PER_MASK_WORD);
    }
    mask
}

fn words_of(mask: Option<&Vec<u32>>) -> (*const u32, usize) {
    mask.map_or((ptr::null(), 0), |words| (words.as_ptr(), words.len()))
}

fn walk_failed(
    field: &ColdField,
    status: ffi::narsil_status,
    fault: &ffi::narsil_page_fault,
) -> crate::error::NarsilError {
    match status {
        ffi::NARSIL_PAGE_CORRUPT | ffi::NARSIL_PAGE_UNREADABLE | ffi::NARSIL_PAGE_INVALID => field
            .page_failed(status, fault)
            .unwrap_or_else(|| core_refused("a paged vector search", status)),
        status => core_failed(status, "search a paged vector field"),
    }
}

pub(super) fn walk_graph(walk: &GraphWalk<'_>) -> Result<Vec<VectorHit>> {
    let field = walk.field;
    let options = walk.options;
    let floor = if options.min_similarity.is_nan() {
        f64::NEG_INFINITY
    } else {
        options.min_similarity
    };
    if floor == f64::INFINITY {
        return Ok(Vec::new());
    }
    let depths = depths_for(field.code_bits(), field.dimension(), walk.k, options);
    let capacity = (field.total() as usize).min(depths.ef).max(1);
    let mut numbers = vec![0u32; capacity];
    let mut scores = vec![0f64; capacity];
    let accepted = walk
        .accepted
        .map(|admitted| mask_of(field.total(), admitted));
    let excluded = (!walk.excluded.is_empty()).then(|| mask_of(field.total(), walk.excluded));
    let (accepted_words, accepted_count) = words_of(accepted.as_ref());
    let (excluded_words, excluded_count) = words_of(excluded.as_ref());
    let meter = WorkMeter::new(i64::MAX);
    let request = ffi::narsil_paged_vector_request {
        query: walk.query.as_ptr(),
        query_count: walk.query.len(),
        k: u32::try_from(walk.k).unwrap_or(u32::MAX),
        ef: u32::try_from(depths.ef).unwrap_or(u32::MAX),
        rescore_depth: u32::try_from(depths.depth).unwrap_or(u32::MAX),
        explicit_rescore_window: i32::from(options.rescore_window.is_some()),
        min_similarity: floor,
        accepted: accepted_words,
        accepted_words: accepted_count,
        excluded: excluded_words,
        excluded_words: excluded_count,
        meter: meter.native(),
    };
    let output = ffi::narsil_paged_vector_output {
        ordinals: numbers.as_mut_ptr(),
        ordinal_capacity: capacity,
        scores: scores.as_mut_ptr(),
        score_capacity: capacity,
    };
    let mut found = 0u32;
    let (status, fault) = field.with_core_field(metric_code(options.metric), |core_field| {
        paged_read(|workspace, cache, fault| unsafe {
            ffi::narsil_search_paged_vectors(
                workspace, cache, core_field, &request, &output, &mut found, fault,
            )
        })
    })?;
    if status != ffi::NARSIL_OK {
        return Err(walk_failed(field, status, &fault));
    }
    let found = (found as usize).min(capacity);
    let scored = scores[..found]
        .iter()
        .zip(&numbers[..found])
        .filter(|&(_, &number)| number < field.total())
        .map(|(&score, &number)| (score, number))
        .collect();
    ranked_by_id(field, scored, walk.k)
}
