use std::time::{Duration, Instant};

use super::constants::{MAX_PREFIX_LENGTH, MAX_TOLERANCE, PREFLIGHT_VECTOR_DEPTH};
use super::embedded::resolve_vector_text;
use super::gather::{QueryRun, RunShape, search_text};
use super::hybrid::hybrid_hits;
use super::params::{QueryParams, TermMatch};
use super::phrases::require_usable_phrases;
use super::require_integer_up_to;
use super::scope::QueryScope;
use super::validate::{require_sortable_fields, require_usable_query_fields};
use super::vector::{SearchPlan, plan_search, require_vector_searchable, vector_hits};
use crate::engine::Narsil;
use crate::engine::index::IndexState;
use crate::error::Result;
use crate::pattern::SearchLimits;

/// What [`Narsil::preflight`] returns: how many documents a query matches, without a single hit.
#[derive(Debug, Clone, PartialEq)]
pub struct PreflightResult {
    /// The number of documents that the query matches.
    pub count: u64,
    /// Whether `count` is exact; a vector or hybrid count that the search could not finish exactly is a number at
    /// or below the true total.
    pub count_exact: bool,
    /// The time that the count took.
    pub elapsed: Duration,
    /// Whether the index's terms came from an older analysis than its language produces now, so that the count can
    /// differ from what a rebuilt index would return.
    pub analysis_stale: bool,
}

/// Returns a copy of `params` without the options that shape the output alone, so that a count keeps no more than
/// one hit, while a `min_score` floor and a `term_match` policy still narrow the matches that it counts.
fn counting_params(params: &QueryParams) -> QueryParams {
    QueryParams {
        limit: Some(0),
        offset: None,
        sort: None,
        group: None,
        pinned: None,
        search_after: None,
        highlight: None,
        facets: None,
        rerank: None,
        include_scores: None,
        include_score_components: None,
        document: None,
        ..params.clone()
    }
}

fn counts_without_scores(params: &QueryParams) -> bool {
    params.min_score.is_none()
        && params
            .term_match
            .is_none_or(|policy| policy == TermMatch::Any)
}

fn text_count(run: &QueryRun<'_>, counting: &QueryParams) -> Result<u64> {
    if !counts_without_scores(counting) {
        return Ok(search_text(run, counting, false, false)?.total_matched);
    }
    let walked = search_text(run, counting, true, true)?;
    Ok(walked
        .matched
        .iter()
        .flatten()
        .flatten()
        .flatten()
        .map(|word| u64::from(word.count_ones()))
        .sum())
}

fn preflight_count(
    index: &IndexState,
    params: &QueryParams,
    resolved: &QueryParams,
    limits: &SearchLimits,
    started: Instant,
) -> Result<PreflightResult> {
    let counting = counting_params(resolved);
    let plan = plan_search(&counting)?;
    require_integer_up_to("tolerance", resolved.tolerance, MAX_TOLERANCE)?;
    require_integer_up_to("prefixLength", resolved.prefix_length, MAX_PREFIX_LENGTH)?;
    require_sortable_fields(index, resolved.sort.as_deref())?;
    let scope = QueryScope::new(index, resolved.filters.as_ref(), limits)?;
    require_usable_query_fields(index, resolved)?;
    require_vector_searchable(index, resolved, plan)?;
    let shape = RunShape {
        requested: params,
        limit: PREFLIGHT_VECTOR_DEPTH,
        offset: 0,
        signature: None,
    };
    let run = QueryRun::new(index, resolved, &scope, shape)?;
    if plan != SearchPlan::Vector {
        require_usable_phrases(
            &run.snapshots.layout.analyser,
            resolved.term.as_deref(),
            index.track_positions,
        )?;
    }
    let (count, count_exact) = match plan {
        SearchPlan::Vector => {
            let found = vector_hits(&run, 0)?;
            (found.total_matched, found.exact)
        }
        SearchPlan::Hybrid => {
            let found = hybrid_hits(&run, 0)?;
            (found.total_matched, found.exact)
        }
        SearchPlan::Text => (text_count(&run, &counting)?, true),
    };
    Ok(PreflightResult {
        count,
        count_exact,
        elapsed: started.elapsed(),
        analysis_stale: index.analysis_stale(),
    })
}

impl Narsil {
    /// Returns how many documents a query matches without building a single hit, which keeps a result-count badge
    /// cheap.
    ///
    /// A full-text count reads no stored document and keeps no more than one hit, and a `min_score` floor or a
    /// `term_match` policy still narrows what it counts. A vector or hybrid count runs its search to the first 1,000
    /// results, so `count_exact` comes back false where more documents can match. The engine
    /// ignores every option that shapes the output alone, such as `limit`, `sort`, and `highlight`, and fails with
    /// the codes that [`Narsil::query`] raises for a query that it cannot run.
    pub fn preflight(&self, index: &str, params: &QueryParams) -> Result<PreflightResult> {
        let started = Instant::now();
        self.inner.read_index_prepared(
            index,
            |current, earlier| resolve_vector_text(current, params, earlier),
            |current, embedded| {
                preflight_count(
                    current,
                    params,
                    &embedded.params,
                    &self.inner.search_limits,
                    started,
                )
            },
        )
    }
}
