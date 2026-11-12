mod call;
mod finish;
mod order;
mod plan;

use std::borrow::Cow;
use std::sync::Arc;

use super::constants::{DEFAULT_PAGE_SIZE, RESULT_WINDOW};
use super::cursor::{decode_page_cursor, query_binding_of, require_matching_cursor};
use super::fusion::{fixed_hybrid_depth, require_within_hybrid_depth};
use super::params::{DocumentProjection, Pin, QueryParams, RerankConfig, SearchMode};
use super::projection::resolve_projection;
use super::results::QueryResult;
use super::shaped_query;
use super::vector::has_term;
use crate::engine::index::IndexState;
use crate::engine::vectors::paths::value_at;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::index::partition::Partition;
use crate::pattern::SearchLimits;
use crate::value::Value;
use call::score_documents;
use finish::{StagedPage, finish_page};
use order::{placed_hits, unordered};
use plan::resolve_rerank;

pub(crate) use finish::AwaitingScores;
pub(crate) use plan::rerank_query_text;

pub(crate) struct RerankRequest<'a> {
    pub(crate) params: Cow<'a, QueryParams>,
    pub(crate) requested: &'a QueryParams,
    pub(crate) rerank: &'a RerankConfig,
    pub(crate) query_text: Option<String>,
    pub(crate) limits: &'a SearchLimits,
}

/// Where a query stands once its read of the index ends: answered, or waiting for the rerank adapter to score the
/// best hits of its first stage.
pub(crate) enum QueryStep<'a> {
    Answered(QueryResult),
    Reranking(Box<AwaitingScores<'a>>),
}

fn fuses_rankings(params: &QueryParams) -> bool {
    params.vector.is_some() && (params.mode == Some(SearchMode::Hybrid) || has_term(params))
}

fn first_stage_depth(
    hybrid_depth: Option<usize>,
    window: usize,
    cursor_depth: usize,
    offset: usize,
    limit: usize,
) -> Result<usize> {
    let Some(depth) = hybrid_depth else {
        let reach = cursor_depth.saturating_add(offset).saturating_add(limit);
        if reach > RESULT_WINDOW {
            return Err(NarsilError::new(
                ErrorCode::SEARCH_RESULT_WINDOW_EXCEEDED,
                format!(
                    "The engine pages a reranked query through the first {RESULT_WINDOW} results, and this page ends at {reach}"
                ),
            ));
        }
        return Ok(window
            .saturating_add(1)
            .max(reach.saturating_add(1).min(RESULT_WINDOW)));
    };
    require_within_hybrid_depth(cursor_depth, offset, depth)?;
    Ok(depth)
}

fn rerank_text(
    index: &IndexState,
    partitions: &[Arc<Partition>],
    id: &str,
    fields: &[String],
) -> Result<String> {
    let Some(partition) = index
        .locate(partitions, id)?
        .and_then(|at| partitions.get(at))
    else {
        return Ok(String::new());
    };
    let Some(document) = partition.snapshot().document(id)? else {
        return Ok(String::new());
    };
    let mut lines: Vec<&str> = Vec::new();
    for field in fields {
        match value_at(&document, field) {
            Some(Value::String(text)) => lines.push(text),
            Some(Value::Array(items)) => lines.extend(items.iter().filter_map(|item| match item {
                Value::String(text) => Some(text.as_str()),
                _ => None,
            })),
            _ => {}
        }
    }
    Ok(lines.join("\n"))
}

fn cursor_depth(params: &QueryParams, binding: &str) -> Result<usize> {
    let Some(cursor) = params.search_after.as_deref() else {
        return Ok(0);
    };
    let decoded = decode_page_cursor(cursor)?;
    require_matching_cursor(&decoded, None, true, binding)?;
    Ok(usize::try_from(decoded.depth).unwrap_or(usize::MAX))
}

fn stored_pins(
    index: &IndexState,
    partitions: &[Arc<Partition>],
    pins: &[Pin],
) -> Result<Vec<Pin>> {
    let mut stored = Vec::with_capacity(pins.len());
    for pin in pins {
        if index.locate(partitions, &pin.doc_id)?.is_some() {
            stored.push(pin.clone());
        }
    }
    Ok(stored)
}

/// Runs the first stage of a reranked query on `index`, which a read holds, and returns the query's page where the
/// rerank adapter has no hit to score, or the texts of the best hits that it waits for the adapter to score.
pub(crate) fn reranked_query<'a>(
    index: &Arc<IndexState>,
    request: RerankRequest<'a>,
) -> Result<QueryStep<'a>> {
    let RerankRequest {
        params: resolved,
        requested,
        rerank,
        query_text,
        limits,
    } = request;
    let params = resolved.as_ref();
    let fuses = fuses_rankings(params);
    let hybrid_depth = match fuses {
        true => fixed_hybrid_depth(params.hybrid.as_ref())?,
        false => None,
    };
    let registry = index.vectors.adapters();
    let max_window = registry.rerank_settings().max_window;
    let plan = resolve_rerank(
        params,
        rerank,
        &index.schema,
        hybrid_depth,
        max_window,
        query_text,
    )?;
    let limit = params.limit.unwrap_or(DEFAULT_PAGE_SIZE);
    let offset = params.offset.unwrap_or(0);
    let binding = query_binding_of(requested);
    let cursor_depth = cursor_depth(params, &binding)?;
    let depth = first_stage_depth(hybrid_depth, plan.window, cursor_depth, offset, limit)?;
    let start = cursor_depth.saturating_add(offset);
    let projection = resolve_projection(params.document.as_ref());
    let mut first_params = params.clone();
    first_params.rerank = None;
    first_params.pinned = None;
    first_params.search_after = None;
    first_params.highlight = None;
    first_params.offset = Some(0);
    first_params.limit = Some(depth);
    first_params.document = Some(DocumentProjection::None);
    let places_pins = params.search_after.is_none() && params.pinned.is_some();
    let counts_apart = places_pins || (params.vector.is_some() && !fuses);
    let first = shaped_query(index, &first_params, requested, limits)?;
    let plain = match counts_apart {
        true => {
            let mut plain_params = first_params.clone();
            if places_pins {
                plain_params.pinned = params.pinned.clone();
            }
            plain_params.facets = None;
            plain_params.group = None;
            plain_params.offset = Some(start);
            plain_params.limit = Some(limit);
            Some(shaped_query(index, &plain_params, requested, limits)?)
        }
        false => None,
    };
    let partitions = index.partitions();
    let pins = match params.pinned.as_deref().filter(|_| places_pins) {
        Some(pins) => Some(stored_pins(index, &partitions, pins)?),
        None => None,
    };
    let (count, count_exact) = match &plain {
        Some(plain) => (plain.count, plain.count_exact),
        None => (first.count, first.count_exact),
    };
    let QueryResult {
        hits: ranked,
        groups,
        facets,
        coverage,
        analysis_stale,
        ..
    } = first;
    let page_holds_hits = limit > 0 && start < placed_hits(&ranked, pins.as_deref())?.len();
    let page = StagedPage {
        pins,
        binding,
        start,
        limit,
        projection,
        summary: QueryResult {
            hits: Vec::new(),
            count,
            count_exact,
            elapsed: std::time::Duration::ZERO,
            cursor: None,
            facets,
            groups,
            analysis_stale,
            coverage,
        },
    };
    let window_size = plan.window.min(ranked.len());
    if window_size == 0 || !page_holds_hits {
        score_documents(registry, &plan.adapter, &plan.query, Vec::new())?;
        let answered = finish_page(index, params, page, unordered(ranked))?;
        return Ok(QueryStep::Answered(answered));
    }
    let texts = ranked
        .iter()
        .take(window_size)
        .map(|hit| rerank_text(index, &partitions, &hit.id, &plan.fields))
        .collect::<Result<Vec<String>>>()?;
    Ok(QueryStep::Reranking(Box::new(AwaitingScores {
        ranked_on: Arc::clone(index),
        params: resolved,
        plan,
        ranked,
        texts,
        page,
    })))
}
