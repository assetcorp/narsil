mod assemble;
mod bm25;
pub(crate) mod constants;
mod coverage;
mod cursor;
pub(crate) mod documents;
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

use std::time::{Duration, Instant};

use crate::engine::index::IndexState;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::search::components::ScoreComponents as SegmentComponents;
use constants::{DEFAULT_PAGE_SIZE, MAX_PREFIX_LENGTH, MAX_TOLERANCE, RESULT_WINDOW};
use cursor::sort_signature_of;
use gather::{QueryRun, RunShape};
use params::QueryParams;
use phrases::require_usable_phrases;
use projection::resolve_projection;
use rerank::{RerankRequest, rerank_query_text, reranked_query};
use results::{QueryCoverage, QueryResult, ScoreComponents};
use scope::QueryScope;
use shaped::shaped_page;
use validate::{require_sortable_fields, require_usable_query_fields};
use vector::{SearchPlan, plan_search, require_vector_searchable, resolve_vector_text};

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
    work_cap: i64,
) -> Result<QueryResult> {
    let limit = params.limit.unwrap_or(DEFAULT_PAGE_SIZE);
    let offset = params.offset.unwrap_or(0);
    require_within_result_window(limit, offset)?;
    let signature = sort_signature_of(params.sort.as_deref())?;
    let search = plan_search(params)?;
    require_integer_up_to("tolerance", params.tolerance, MAX_TOLERANCE)?;
    require_integer_up_to("prefixLength", params.prefix_length, MAX_PREFIX_LENGTH)?;
    require_sortable_fields(index, params.sort.as_deref())?;
    let scope = QueryScope::new(index, params.filters.as_ref(), work_cap)?;
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

/// Runs a query against one index, embedding its vector clause's text first and reranking its best hits where it
/// asks for that. Each search of the query may spend `work_cap` units on its pattern tests and phrases.
pub(crate) fn run_query(
    index: &IndexState,
    params: &QueryParams,
    work_cap: i64,
) -> Result<QueryResult> {
    spread::counted(|| {
        let started = Instant::now();
        let rerank_text = params
            .rerank
            .as_ref()
            .and_then(|_| rerank_query_text(params));
        let resolved = resolve_vector_text(index, params)?;
        let mut result = match &resolved.rerank {
            Some(rerank) => {
                let request = RerankRequest {
                    params: &resolved,
                    requested: params,
                    rerank,
                    query_text: rerank_text,
                    work_cap,
                };
                reranked_query(index, request)?
            }
            None => shaped_query(index, &resolved, params, work_cap)?,
        };
        result.elapsed = started.elapsed();
        Ok(result)
    })
}
