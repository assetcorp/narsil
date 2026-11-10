use crate::error::Result;

use super::constants::{
    DEFAULT_EF_SEARCH, EF_SEARCH_MARGIN_MIDDLE, EF_SEARCH_MARGIN_NARROW, EF_SEARCH_MARGIN_WIDE,
    NARROW_DIMENSION_LIMIT, OSQ2_MIDDLE_RESCORE_DEPTH_WITHIN_WALK_PER_SQUARE_ROOT_OF_LIMIT,
    OVERSAMPLED_DEPTH_CAP, RESCORE_DEPTH_FLOOR_PER_LIMIT_OSQ1, RESCORE_DEPTH_FLOOR_PER_LIMIT_OSQ2,
    RESCORE_DEPTH_FLOOR_PER_LIMIT_OSQ4, RESCORE_DEPTH_FLOOR_PER_LIMIT_OSQ8, RESCORE_DEPTH_OSQ1,
    RESCORE_DEPTH_OSQ2, RESCORE_DEPTH_OSQ4, RESCORE_DEPTH_OSQ8, WIDE_DIMENSION_LIMIT,
};
use super::core::{Accepted, Scratch};
use super::field::Generation;
use super::filter::OrdinalFilter;
use super::graph::GraphTables;
use super::ranking::{Ranked, VectorHit};
use super::search::VectorSearchOptions;
use super::settings::{metric_code, to_score};

const NARROW_BAND: usize = 0;
const MIDDLE_BAND: usize = 1;
const WIDE_BAND: usize = 2;

fn dimension_band(dimension: usize) -> usize {
    if dimension < NARROW_DIMENSION_LIMIT {
        NARROW_BAND
    } else if dimension < WIDE_DIMENSION_LIMIT {
        MIDDLE_BAND
    } else {
        WIDE_BAND
    }
}

pub(crate) fn default_ef_search(dimension: usize, k: usize) -> usize {
    let margin = match dimension_band(dimension) {
        NARROW_BAND => EF_SEARCH_MARGIN_NARROW,
        MIDDLE_BAND => EF_SEARCH_MARGIN_MIDDLE,
        _ => EF_SEARCH_MARGIN_WIDE,
    };
    DEFAULT_EF_SEARCH.max(k + margin)
}

pub(crate) fn default_rescore_depth(bits: u8, dimension: usize, k: usize) -> usize {
    let band = dimension_band(dimension);
    let (table, floor) = match bits {
        1 => (RESCORE_DEPTH_OSQ1, RESCORE_DEPTH_FLOOR_PER_LIMIT_OSQ1),
        2 => (RESCORE_DEPTH_OSQ2, RESCORE_DEPTH_FLOOR_PER_LIMIT_OSQ2),
        4 => (RESCORE_DEPTH_OSQ4, RESCORE_DEPTH_FLOOR_PER_LIMIT_OSQ4),
        _ => (RESCORE_DEPTH_OSQ8, RESCORE_DEPTH_FLOOR_PER_LIMIT_OSQ8),
    };
    let (per_limit, per_square_root) = table[band];
    let limit = k as f64;
    let depth =
        (floor * k).max((per_limit * limit + per_square_root * limit.sqrt()).ceil() as usize);
    if bits != 2 || band != MIDDLE_BAND {
        return depth;
    }
    let within_default_walk = (k + EF_SEARCH_MARGIN_MIDDLE).min(
        (limit + OSQ2_MIDDLE_RESCORE_DEPTH_WITHIN_WALK_PER_SQUARE_ROOT_OF_LIMIT * limit.sqrt())
            .ceil() as usize,
    );
    depth.max(within_default_walk)
}

pub(crate) struct SearchDepths {
    pub(crate) ef: usize,
    pub(crate) depth: usize,
    pub(crate) quantised: bool,
}

pub(crate) fn search_depths(
    generation: &Generation,
    k: usize,
    options: &VectorSearchOptions,
) -> SearchDepths {
    let store = &generation.store;
    let quantised = store.bits != 0 && store.calibrated() && store.code_count() > 0;
    let window = options.rescore_window.unwrap_or(k);
    let depth = if !quantised {
        window
    } else {
        let default_depth = default_rescore_depth(store.bits, store.dimension, window);
        match options.oversample {
            Some(oversample) => ((window as f64 * oversample).ceil() as usize)
                .min(default_depth.max(OVERSAMPLED_DEPTH_CAP)),
            None => default_depth,
        }
    };
    let ef = options
        .ef_search
        .unwrap_or_else(|| default_ef_search(store.dimension, window))
        .max(depth)
        .max(1);
    SearchDepths {
        ef,
        depth,
        quantised,
    }
}

fn admitted(request: &GraphQuery<'_>, ordinal: i32) -> bool {
    ordinal >= 0 && request.filter.is_none_or(|found| found.has(ordinal as u32))
}

pub(crate) struct GraphQuery<'a> {
    pub(crate) generation: &'a Generation,
    pub(crate) graph: &'a GraphTables,
    pub(crate) query: &'a [f32],
    pub(crate) k: usize,
    pub(crate) options: &'a VectorSearchOptions,
    pub(crate) filter: Option<&'a OrdinalFilter>,
    pub(crate) pin: i64,
}

pub(crate) fn graph_hits(
    scratch: &mut Scratch,
    request: &GraphQuery<'_>,
) -> Result<Vec<VectorHit>> {
    let generation = request.generation;
    let options = request.options;
    let mut ranked = Ranked::new(&generation.names, request.k);
    if request.graph.is_empty() {
        return Ok(ranked.finish());
    }
    let depths = search_depths(generation, request.k, options);
    let metric = options.metric;
    let accepted = request.filter.map(|found| Accepted { bits: found.bits() });
    let found = scratch.search(
        &generation.store,
        request.graph,
        request.query,
        metric_code(metric),
        depths.ef.min((request.graph.slots() as usize).max(1)),
        accepted,
        request.pin,
    )?;
    let minimum = options.min_similarity;
    if !depths.quantised {
        admit_estimates(scratch, 0..found, request, &mut ranked);
        return Ok(ranked.finish());
    }
    scratch.batch.clear();
    let mut end_of_rescored = found;
    for at in 0..found {
        let ordinal = scratch.ordinals[at];
        if !admitted(request, ordinal) {
            continue;
        }
        scratch.batch.push(ordinal);
        if scratch.batch.len() == depths.depth {
            end_of_rescored = at + 1;
            break;
        }
    }
    let batch = std::mem::take(&mut scratch.batch);
    let scored = scratch.score(
        &generation.store,
        request.query,
        metric_code(metric),
        &batch,
        request.pin,
    );
    scratch.batch = batch;
    scored?;
    for (at, &ordinal) in scratch.batch.iter().enumerate() {
        let distance = scratch.scores[at];
        if distance == f64::INFINITY {
            continue;
        }
        let score = to_score(distance, metric);
        if score < minimum {
            continue;
        }
        ranked.admit(score, ordinal as u32);
    }
    if options.rescore_window.is_some() && minimum == f64::NEG_INFINITY {
        admit_estimates(scratch, end_of_rescored..found, request, &mut ranked);
    }
    Ok(ranked.finish())
}

fn admit_estimates(
    scratch: &Scratch,
    span: std::ops::Range<usize>,
    request: &GraphQuery<'_>,
    ranked: &mut Ranked<'_>,
) {
    let metric = request.options.metric;
    let minimum = request.options.min_similarity;
    for at in span {
        let ordinal = scratch.ordinals[at];
        if !admitted(request, ordinal) {
            continue;
        }
        let score = to_score(scratch.distances[at], metric);
        if score < minimum {
            continue;
        }
        ranked.admit(score, ordinal as u32);
    }
}
