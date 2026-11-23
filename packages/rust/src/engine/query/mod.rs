mod assemble;
mod bm25;
pub(crate) mod confined;
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
pub(crate) mod projected;
pub(crate) mod projection;
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

use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::engine::EngineInner;
use crate::engine::constants::MAX_CALLS_ACROSS_INDEX_CHANGES;
use crate::engine::index::IndexState;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::pattern::SearchLimits;
use crate::search::components::ScoreComponents as SegmentComponents;
use crate::value::Value;
use confined::PartitionQuery;
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
        )
        .with_details([
            ("option", Value::from(option)),
            ("value", Value::from(value.to_string())),
            ("maximum", Value::from(maximum)),
        ])),
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
    )
    .with_details([
        ("limit", Value::from(limit)),
        ("offset", Value::from(offset)),
        ("window", Value::from(RESULT_WINDOW)),
    ]))
}

fn public_components(components: SegmentComponents) -> ScoreComponents {
    ScoreComponents {
        term_frequencies: components.term_frequencies,
        field_lengths: components.field_lengths,
        idf: components.idf,
    }
}

fn shaped_query(
    index: &IndexState,
    params: &QueryParams,
    requested: &QueryParams,
    limits: &SearchLimits,
    confinement: Option<&PartitionQuery>,
) -> Result<QueryResult> {
    let limit = params.limit.unwrap_or(DEFAULT_PAGE_SIZE);
    let offset = params.offset.unwrap_or(0);
    require_within_result_window(limit, offset)?;
    let signature = sort_signature_of(params.sort.as_deref())?;
    let search = plan_search(params)?;
    require_integer_up_to("tolerance", params.tolerance, MAX_TOLERANCE)?;
    require_integer_up_to("prefixLength", params.prefix_length, MAX_PREFIX_LENGTH)?;
    require_sortable_fields(index, params.sort.as_deref())?;
    let scope = QueryScope::new(index, params.filters.as_ref(), limits)?
        .confined_to_partitions(confinement.is_some());
    require_usable_query_fields(index, params)?;
    require_vector_searchable(index, params, search)?;
    let shape = RunShape {
        requested,
        limit,
        offset,
        signature,
        confinement,
    };
    let run = QueryRun::new(index, params, &scope, shape)?;
    if search != SearchPlan::Vector {
        require_usable_phrases(
            &run.snapshots.layout.analyser,
            params.term.as_deref(),
            index.track_positions,
        )?;
    }
    let projection = resolve_projection(params.document.as_ref(), index);
    let page = shaped_page(&run, search, &projection)?;
    let partitions = run.snapshots.partitions.len();
    let (total_partitions, queried_partitions) = match confinement {
        Some(confinement) => (
            confinement.partition_ids.len(),
            confinement.held_count(partitions),
        ),
        None => (partitions, partitions),
    };
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
            total_partitions,
            queried_partitions,
            timed_out_partitions: 0,
            failed_partitions: total_partitions.saturating_sub(queried_partitions),
        },
    })
}

/// Returns the result of `params` on the partitions of the index called `name` that `confinement` lists, scored
/// against the statistics and the BM25 setting that it supplies, with every pinned document left unplaced, so that
/// a cluster coordinator can place the pins after it merges the answers of every node.
pub(crate) fn answer_partition_query(
    engine: &EngineInner,
    name: &str,
    params: &QueryParams,
    confinement: &PartitionQuery,
    started: Instant,
) -> Result<QueryResult> {
    let mut unpinned = params.clone();
    unpinned.pinned = None;
    unpinned.rerank = None;
    let limits = &engine.search_limits;
    let mut result = engine.read_index_prepared(
        name,
        None,
        |current, earlier| resolve_vector_text(current, &unpinned, earlier),
        |current, embedded| {
            spread::counted(|| {
                shaped_query(
                    current,
                    &embedded.params,
                    &unpinned,
                    limits,
                    Some(confinement),
                )
            })
        },
    )?;
    result.elapsed = started.elapsed();
    Ok(result)
}

fn run_query<'a>(
    index: &Arc<IndexState>,
    params: &'a QueryParams,
    embedded: EmbeddedQuery<'a>,
    limits: &'a SearchLimits,
) -> Result<QueryStep<'a>> {
    spread::counted(|| {
        let Some(rerank) = &params.rerank else {
            let answered = shaped_query(index, &embedded.params, params, limits, None)?;
            return Ok(QueryStep::Answered(answered));
        };
        let request = RerankRequest {
            embedded,
            requested: params,
            rerank,
            query_text: rerank_query_text(params),
            limits,
        };
        reranked_query(index, request)
    })
}

fn index_replaced_during_reranks(name: &str, reranks: u32) -> NarsilError {
    NarsilError::new(
        ErrorCode::WORKER_BUSY,
        format!(
            "Changes to index \"{name}\" replaced it during each of {reranks} calls to its rerank adapter"
        ),
    )
    .with_details([
        ("indexName", Value::from(name)),
        ("attempts", Value::from(reranks)),
    ])
}

/// Returns the result of `params` on the index called `name`, reporting the time since `started`. Each search of
/// the query may spend the work cap of `limits` on its pattern tests and phrases, and stops once the engine shuts
/// down. A reranked query asks its rerank adapter for scores while the engine holds no index, then builds its page
/// under a new read. Where a restore or a reopen has put another index under the name by then, the query runs
/// again from its first stage on that index, and it fails with `WORKER_BUSY` once that has happened during each of
/// [`MAX_CALLS_ACROSS_INDEX_CHANGES`] calls to the adapter. A rebalance or an analysis change keeps the index under
/// the name, so the query builds its page on that index and counts no such call.
pub(crate) fn answer_query(
    engine: &EngineInner,
    name: &str,
    params: &QueryParams,
    limits: &SearchLimits,
    started: Instant,
) -> Result<QueryResult> {
    let mut earlier = None;
    let mut replaced_reranks = 0;
    loop {
        let step = engine.read_index_prepared(
            name,
            earlier.take(),
            |current, earlier| resolve_vector_text(current, params, earlier),
            |current, embedded| run_query(current, params, embedded, limits),
        )?;
        let mut awaiting = match step {
            QueryStep::Answered(mut result) => {
                result.elapsed = started.elapsed();
                return Ok(result);
            }
            QueryStep::Reranking(awaiting) => awaiting,
        };
        let scored = awaiting.score();
        let finished = engine.read_index(name, |current| {
            if !awaiting.ranked_on(current) {
                return Ok(Err(awaiting));
            }
            let scores = scored?;
            spread::counted(|| awaiting.finish(current, scores)).map(Ok)
        })?;
        let replaced = match finished {
            Ok(mut result) => {
                result.elapsed = started.elapsed();
                return Ok(result);
            }
            Err(replaced) => replaced,
        };
        replaced_reranks += 1;
        if replaced_reranks >= MAX_CALLS_ACROSS_INDEX_CHANGES {
            return Err(index_replaced_during_reranks(name, replaced_reranks));
        }
        earlier = Some(replaced.into_embedded());
    }
}
