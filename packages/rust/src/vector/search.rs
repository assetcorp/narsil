use crate::config::Metric;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::pins::Pin;

use super::build::schedule_build;
use super::cold::{ColdQuery, search_cold};
use super::constants::{
    MAX_EF_SEARCH, MAX_RESCORE_WINDOW, MAX_SEARCH_K, MIN_EF_SEARCH, MIN_OVERSAMPLE,
    MIN_RESCORE_WINDOW, SCORE_CHUNK_VECTORS,
};
use super::core::{Scratch, with_scratch};
use super::field::{Generation, VectorField};
use super::filter::OrdinalFilter;
use super::graph_search::{GraphQuery, graph_hits};
use super::ranking::{Ranked, VectorHit, merge_results};
use super::settings::{metric_code, to_score};
use super::writes::require_dimension_of;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct VectorSearchOptions {
    pub(crate) metric: Metric,
    pub(crate) min_similarity: f64,
    pub(crate) ef_search: Option<usize>,
    pub(crate) oversample: Option<f64>,
    pub(crate) rescore_window: Option<usize>,
}

impl Default for VectorSearchOptions {
    fn default() -> VectorSearchOptions {
        VectorSearchOptions {
            metric: Metric::Cosine,
            min_similarity: f64::NEG_INFINITY,
            ef_search: None,
            oversample: None,
            rescore_window: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct VectorSearchOutcome {
    pub(crate) results: Vec<VectorHit>,
    pub(crate) matched: u64,
    pub(crate) matched_exact: bool,
}

fn invalid(message: String) -> NarsilError {
    NarsilError::new(ErrorCode::CONFIG_INVALID, message)
}

impl VectorSearchOptions {
    pub(crate) fn validate(&self, k: usize) -> Result<()> {
        if let Some(oversample) = self.oversample
            && (!oversample.is_finite() || oversample < MIN_OVERSAMPLE)
        {
            return Err(invalid(format!(
                "vector.oversample must be a finite number of at least {MIN_OVERSAMPLE}"
            )));
        }
        if let Some(ef_search) = self.ef_search
            && !(MIN_EF_SEARCH..=MAX_EF_SEARCH).contains(&ef_search)
        {
            return Err(invalid(format!(
                "vector.efSearch must be a whole number from {MIN_EF_SEARCH} to {MAX_EF_SEARCH}"
            )));
        }
        if let Some(window) = self.rescore_window
            && !(MIN_RESCORE_WINDOW..=MAX_RESCORE_WINDOW).contains(&window)
        {
            return Err(invalid(format!(
                "vector.rescoreWindow must be a whole number from {MIN_RESCORE_WINDOW} to {MAX_RESCORE_WINDOW}, got {window}"
            )));
        }
        if k > MAX_SEARCH_K {
            return Err(invalid(format!(
                "A vector search returns at most {MAX_SEARCH_K} results, and this one asks for {k}"
            )));
        }
        Ok(())
    }
}

fn not_a_number(at: usize) -> NarsilError {
    NarsilError::new(
        ErrorCode::DOC_VALIDATION_FAILED,
        format!("The query vector element at index {at} is not a valid number"),
    )
}

fn require_usable_query(query: &[f32]) -> Result<()> {
    match query.iter().position(|value| !value.is_finite()) {
        Some(at) => Err(not_a_number(at)),
        None => Ok(()),
    }
}

fn empty(exact_count: u64) -> VectorSearchOutcome {
    VectorSearchOutcome {
        results: Vec::new(),
        matched: exact_count,
        matched_exact: true,
    }
}

fn fetched(
    generation: &Generation,
    results: Vec<VectorHit>,
    options: &VectorSearchOptions,
    filter: Option<&OrdinalFilter>,
) -> VectorSearchOutcome {
    if options.min_similarity == f64::NEG_INFINITY {
        let admitted = filter.map_or_else(|| generation.counts.live(), OrdinalFilter::count);
        return VectorSearchOutcome {
            results,
            matched: admitted,
            matched_exact: true,
        };
    }
    VectorSearchOutcome {
        matched: results.len() as u64,
        results,
        matched_exact: false,
    }
}

pub(crate) struct Scan<'a> {
    pub(crate) generation: &'a Generation,
    pub(crate) query: &'a [f32],
    pub(crate) k: usize,
    pub(crate) options: &'a VectorSearchOptions,
    pub(crate) pin: i64,
}

pub(crate) fn scan(
    scratch: &mut Scratch,
    request: &Scan<'_>,
    ordinals: impl Iterator<Item = u32>,
) -> Result<(Vec<VectorHit>, u64)> {
    let generation = request.generation;
    let mut ranked = Ranked::new(&generation.names, request.k);
    let mut batch = std::mem::take(&mut scratch.batch);
    batch.clear();
    let mut outcome = Ok(());
    for ordinal in ordinals {
        batch.push(ordinal as i32);
        if batch.len() == SCORE_CHUNK_VECTORS {
            outcome = score_batch(scratch, request, &batch, &mut ranked);
            batch.clear();
            if outcome.is_err() {
                break;
            }
        }
    }
    if outcome.is_ok() && !batch.is_empty() {
        outcome = score_batch(scratch, request, &batch, &mut ranked);
    }
    scratch.batch = batch;
    outcome?;
    let matched = ranked.matched;
    Ok((ranked.finish(), matched))
}

fn score_batch(
    scratch: &mut Scratch,
    request: &Scan<'_>,
    batch: &[i32],
    ranked: &mut Ranked<'_>,
) -> Result<()> {
    let metric = request.options.metric;
    scratch.score(
        &request.generation.store,
        request.query,
        metric_code(metric),
        batch,
        request.pin,
    )?;
    for (at, &ordinal) in batch.iter().enumerate() {
        let distance = scratch.scores[at];
        if distance == f64::INFINITY {
            continue;
        }
        let score = to_score(distance, metric);
        if score < request.options.min_similarity {
            continue;
        }
        ranked.admit(score, ordinal as u32);
    }
    Ok(())
}

impl VectorField {
    pub(crate) fn search(
        &self,
        query: &[f32],
        k: usize,
        options: &VectorSearchOptions,
        matching: Option<&[&str]>,
        pin: &Pin,
    ) -> Result<VectorSearchOutcome> {
        options.validate(k)?;
        require_dimension_of(&self.shared, query.len())?;
        require_usable_query(query)?;
        let pin = pin.value();
        if let Some(hold) = self.shared.cold_hold() {
            let outcome = search_cold(
                &hold,
                &ColdQuery {
                    query,
                    k,
                    options,
                    matching,
                    pin,
                    filter_threshold: self.shared.settings.filter_threshold,
                },
            );
            hold.want_load();
            return outcome;
        }
        let generation = self.shared.current();
        let admitted = matching.map(|doc_ids| generation.filter_of(doc_ids.iter().copied(), pin));
        let filter = admitted.as_ref();
        if generation.store.slots() == 0 || filter.is_some_and(|found| found.count() == 0) {
            return Ok(empty(0));
        }
        if k == 0 {
            return Ok(fetched(&generation, Vec::new(), options, filter));
        }
        if generation.buffer.len() > 0 {
            schedule_build(&self.shared);
        }
        let threshold = self.shared.settings.filter_threshold;
        with_scratch(|scratch| {
            let request = Scan {
                generation: &generation,
                query,
                k,
                options,
                pin,
            };
            let Some(graph) = &generation.graph else {
                return exact_scan(scratch, &request, filter);
            };
            if let Some(found) = filter {
                let size = graph.size();
                let selectivity = if size > 0 {
                    found.count() as f64 / size as f64
                } else {
                    1.0
                };
                if selectivity < threshold {
                    return exact_scan(scratch, &request, filter);
                }
            }
            let hits = graph_hits(
                scratch,
                &GraphQuery {
                    generation: &generation,
                    graph,
                    query,
                    k,
                    options,
                    filter,
                    pin,
                },
            )?;
            if generation.buffer.len() == 0 {
                return Ok(fetched(&generation, hits, options, filter));
            }
            let buffered = generation
                .buffer
                .ordinals()
                .filter(|&ordinal| filter.is_none_or(|found| found.has(ordinal)));
            let (from_buffer, _) = scan(scratch, &request, buffered)?;
            Ok(fetched(
                &generation,
                merge_results(hits, from_buffer, k),
                options,
                filter,
            ))
        })
    }
}

fn exact_scan(
    scratch: &mut Scratch,
    request: &Scan<'_>,
    filter: Option<&OrdinalFilter>,
) -> Result<VectorSearchOutcome> {
    let (results, matched) = match filter {
        Some(found) => scan(scratch, request, found.ordinals().iter().copied())?,
        None => scan(scratch, request, 0..request.generation.store.slots())?,
    };
    Ok(VectorSearchOutcome {
        results,
        matched,
        matched_exact: true,
    })
}
