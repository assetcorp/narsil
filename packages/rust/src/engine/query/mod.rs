mod assemble;
mod bm25;
pub(crate) mod constants;
mod coverage;
mod cursor;
pub(crate) mod documents;
mod embedded;
mod facets;
mod fulltext;
mod fusion;
mod gather;
mod grouping;
mod groups;
mod highlight;
mod hybrid;
pub(crate) mod listing;
mod page_start;
mod pagination;
pub(crate) mod params;
mod phrases;
mod pinned;
pub(crate) mod preflight;
mod projection;
mod ranked;
mod rerank;
pub(crate) mod results;
mod scope;
mod scored;
mod scoring;
mod shaped;
mod sort_candidates;
mod sort_keys;
mod sorted;
pub(crate) mod spread;
mod validate;
mod vector;
mod work;

use std::borrow::Cow;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::engine::EngineInner;
use crate::engine::index::IndexState;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::pattern::SearchLimits;
use crate::search::components::ScoreComponents as SegmentComponents;
use constants::{DEFAULT_PAGE_SIZE, MAX_PREFIX_LENGTH, MAX_TOLERANCE, RESULT_WINDOW};
use cursor::sort_signature_of;
use embedded::{EmbeddedQuery, resolve_vector_text};
use gather::{QueryRun, RunShape};
use params::QueryParams;
use phrases::require_usable_phrases;
use projection::resolve_projection;
use rerank::{QueryStep, RerankRequest, rerank_query_text, reranked_query};
use results::{QueryCoverage, QueryResult, ScoreComponents};
use scope::QueryScope;
use shaped::shaped_page;
use validate::{require_sortable_fields, require_usable_query_fields};
use vector::{SearchPlan, plan_search, require_vector_searchable};

fn require_integer_up_to(option: &str, value: Option<u32>, maximum: u32) -> Result<()> {
    match value {
        Some(value) if value > maximum => Err(NarsilError::new(
            ErrorCode::CONFIG_INVALID,
            format!(
                "The query option \"{option}\" takes an integer from 0 to {maximum}, and this query sets {value}"
            ),
        )),
        _ => Ok(()),
    }
}

fn require_within_result_window(limit: usize, offset: usize) -> Result<()> {
    let depth = offset.saturating_add(limit);
    if depth <= RESULT_WINDOW {
        return Ok(());
    }
    Err(NarsilError::new(
        ErrorCode::SEARCH_RESULT_WINDOW_EXCEEDED,
        format!(
            "A request reaches the first {RESULT_WINDOW} results, and offset + limit is {depth}. Page past that with the cursor each result carries"
        ),
    ))
}

fn public_components(components: SegmentComponents) -> ScoreComponents {
    ScoreComponents {
        term_frequencies: components.term_frequencies.into_iter().collect(),
        field_lengths: components.field_lengths.into_iter().collect(),
        idf: components.idf.into_iter().collect(),
    }
}

fn shaped_query(
    index: &IndexState,
    params: &QueryParams,
    requested: &QueryParams,
    limits: &SearchLimits,
) -> Result<QueryResult> {
    let limit = params.limit.unwrap_or(DEFAULT_PAGE_SIZE);
    let offset = params.offset.unwrap_or(0);
    require_within_result_window(limit, offset)?;
    let signature = sort_signature_of(params.sort.as_deref())?;
    let search = plan_search(params)?;
    require_integer_up_to("tolerance", params.tolerance, MAX_TOLERANCE)?;
    require_integer_up_to("prefixLength", params.prefix_length, MAX_PREFIX_LENGTH)?;
    require_sortable_fields(index, params.sort.as_deref())?;
    let scope = QueryScope::new(index, params.filters.as_ref(), limits)?;
    require_usable_query_fields(index, params)?;
    require_vector_searchable(index, params, search)?;
    let shape = RunShape {
        requested,
        limit,
        offset,
        signature,
    };
    let run = QueryRun::new(index, params, &scope, shape)?;
    if search != SearchPlan::Vector {
        require_usable_phrases(
            &run.snapshots.layout.analyser,
            params.term.as_deref(),
            index.track_positions,
        )?;
    }
    let projection = resolve_projection(params.document.as_ref());
    let page = shaped_page(&run, search, &projection)?;
    let partitions = run.snapshots.partitions.len();
    Ok(QueryResult {
        hits: page.hits,
        count: page.count,
        count_exact: page.count_exact,
        elapsed: Duration::ZERO,
        cursor: page.cursor,
        facets: page.facets,
        groups: page.groups,
        analysis_stale: index.analysis_stale(),
        coverage: QueryCoverage {
            total_partitions: partitions,
            queried_partitions: partitions,
            timed_out_partitions: 0,
            failed_partitions: 0,
        },
    })
}

/// Returns `params` with the vector that the index's embedding adapter makes from the text of its vector clause,
/// or `params` as they stand where the clause gives a vector or no clause appears. Where `earlier` holds a query
/// that the same adapter embedded and that no read found superseded, it comes back as it stands.
pub(crate) fn embed_query_text<'a>(
    index: &IndexState,
    params: &'a QueryParams,
    earlier: Option<EmbeddedQuery<'a>>,
) -> Result<EmbeddedQuery<'a>> {
    resolve_vector_text(index, params, earlier)
}

/// Runs a query whose vector clause [`embed_query_text`] has resolved against one index, which a read holds. Where
/// `params` asks for a rerank, the query stops once its first stage has ranked the hits that the rerank adapter
/// scores, and [`finish_query`] completes it. Each search of the query may spend the work cap of `limits` on its
/// pattern tests and phrases, and stops once the engine shuts down.
pub(crate) fn run_query<'a>(
    index: &Arc<IndexState>,
    params: &'a QueryParams,
    resolved: Cow<'a, QueryParams>,
    limits: &'a SearchLimits,
) -> Result<QueryStep<'a>> {
    spread::counted(|| {
        let Some(rerank) = &params.rerank else {
            let answered = shaped_query(index, &resolved, params, limits)?;
            return Ok(QueryStep::Answered(answered));
        };
        let request = RerankRequest {
            params: resolved,
            requested: params,
            rerank,
            query_text: rerank_query_text(params),
            limits,
        };
        reranked_query(index, request)
    })
}

/// Returns the result of a query that [`run_query`] ran on the index called `name`, reporting the time since
/// `started`. A query that waits for a rerank adapter asks it for scores while the engine holds no index, then
/// builds its page under a new read of the index that holds the name by then.
pub(crate) fn finish_query(
    engine: &EngineInner,
    name: &str,
    step: QueryStep<'_>,
    started: Instant,
) -> Result<QueryResult> {
    let mut result = match step {
        QueryStep::Answered(result) => result,
        QueryStep::Reranking(mut awaiting) => {
            let scores = awaiting.score()?;
            engine.read_index(name, |current| {
                spread::counted(|| awaiting.finish(current, scores))
            })?
        }
    };
    result.elapsed = started.elapsed();
    Ok(result)
}
