mod call;
mod order;
mod plan;

use std::collections::HashSet;
use std::sync::Arc;

use super::constants::{DEFAULT_PAGE_SIZE, RESULT_WINDOW};
use super::cursor::{decode_page_cursor, query_binding_of, require_matching_cursor};
use super::fusion::{fixed_hybrid_depth, require_within_hybrid_depth};
use super::highlight::highlight_hits;
use super::pagination::{PositionWindow, page_by_position};
use super::params::{DocumentProjection, Pin, QueryParams, RerankConfig, SearchMode};
use super::projection::{Projection, project_document, resolve_projection};
use super::results::{Hit, QueryResult};
use super::shaped_query;
use super::vector::has_term;
use crate::engine::index::IndexState;
use crate::engine::vectors::paths::value_at;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::index::partition::Partition;
use crate::value::Value;
use call::score_documents;
use order::{Reordered, place_pins, reorder_by_rerank, unordered};
use plan::resolve_rerank;

pub(crate) use plan::rerank_query_text;

pub(crate) struct RerankRequest<'a> {
    pub(crate) params: &'a QueryParams,
    pub(crate) requested: &'a QueryParams,
    pub(crate) rerank: &'a RerankConfig,
    pub(crate) query_text: Option<String>,
    pub(crate) work_cap: i64,
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

fn with_documents(
    index: &IndexState,
    partitions: &[Arc<Partition>],
    hits: Vec<Hit>,
    projection: &Projection,
) -> Result<Vec<Hit>> {
    let mut filled = Vec::with_capacity(hits.len());
    for mut hit in hits {
        hit.document = match projection {
            Projection::Nothing => Default::default(),
            _ => match index.full_document(partitions, &hit.id)? {
                Some(document) => project_document(&document, projection),
                None => continue,
            },
        };
        filled.push(hit);
    }
    Ok(filled)
}

fn ordered_hits(
    index: &IndexState,
    plan: &plan::RerankPlan,
    ranked: Vec<Hit>,
    scores_window: bool,
) -> Result<Reordered> {
    let registry = index.vectors.adapters();
    let window_size = plan.window.min(ranked.len());
    if window_size == 0 || !scores_window {
        score_documents(registry, &plan.adapter, &plan.query, Vec::new())?;
        return Ok(unordered(ranked));
    }
    let partitions = index.partitions();
    let texts = ranked
        .iter()
        .take(window_size)
        .map(|hit| rerank_text(index, &partitions, &hit.id, &plan.fields))
        .collect::<Result<Vec<String>>>()?;
    let scores = score_documents(registry, &plan.adapter, &plan.query, texts)?;
    Ok(reorder_by_rerank(ranked, window_size, &scores))
}

pub(crate) fn reranked_query(
    index: &IndexState,
    request: RerankRequest<'_>,
) -> Result<QueryResult> {
    let params = request.params;
    let fuses = fuses_rankings(params);
    let hybrid_depth = match fuses {
        true => fixed_hybrid_depth(params.hybrid.as_ref())?,
        false => None,
    };
    let max_window = index.vectors.adapters().rerank_settings().max_window;
    let plan = resolve_rerank(
        params,
        request.rerank,
        &index.schema,
        hybrid_depth,
        max_window,
        request.query_text,
    )?;
    let limit = params.limit.unwrap_or(DEFAULT_PAGE_SIZE);
    let offset = params.offset.unwrap_or(0);
    let binding = query_binding_of(request.requested);
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
    let first = shaped_query(index, &first_params, request.requested, request.work_cap)?;
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
            Some(shaped_query(
                index,
                &plain_params,
                request.requested,
                request.work_cap,
            )?)
        }
        false => None,
    };
    let partitions = index.partitions();
    let pins = match params.pinned.as_deref().filter(|_| places_pins) {
        Some(pins) => Some(stored_pins(index, &partitions, pins)?),
        None => None,
    };
    let QueryResult {
        hits: ranked,
        groups,
        facets,
        coverage,
        analysis_stale,
        count: first_count,
        count_exact: first_exact,
        ..
    } = first;
    let page_holds_hits = limit > 0 && start < place_pins(&ranked, pins.as_deref()).len();
    let ordered = ordered_hits(index, &plan, ranked, page_holds_hits)?;
    let placed = place_pins(&ordered.hits, pins.as_deref());
    let pinned_ids: Option<HashSet<&str>> = pins
        .as_ref()
        .map(|pins| pins.iter().map(|pin| pin.doc_id.as_str()).collect());
    let organic: Vec<&str> = ordered.hits.iter().map(|hit| hit.id.as_str()).collect();
    let page = page_by_position(
        &placed,
        &organic,
        &PositionWindow {
            start,
            limit,
            pinned_ids: pinned_ids.as_ref(),
            binding: &binding,
        },
    );
    let mut hits = with_documents(index, &partitions, placed[page.range].to_vec(), &projection)?;
    let mut groups = groups;
    for group in groups.iter_mut().flatten() {
        let held = std::mem::take(&mut group.hits);
        group.hits = with_documents(index, &partitions, held, &projection)?;
    }
    highlight_hits(index, &partitions, params, &mut hits, &projection)?;
    share_highlights(&mut groups, &hits, &ordered.shared_ids, pinned_ids.as_ref());
    let (count, count_exact) = match &plain {
        Some(plain) => (plain.count, plain.count_exact),
        None => (first_count, first_exact),
    };
    Ok(QueryResult {
        hits,
        count,
        count_exact,
        elapsed: std::time::Duration::ZERO,
        cursor: page.cursor,
        facets,
        groups,
        analysis_stale,
        coverage,
    })
}

fn share_highlights(
    groups: &mut Option<Vec<super::results::GroupResult>>,
    page: &[Hit],
    shared_ids: &HashSet<String>,
    pinned_ids: Option<&HashSet<&str>>,
) {
    for group in groups.iter_mut().flatten() {
        for hit in group.hits.iter_mut() {
            let shared = shared_ids.contains(&hit.id)
                && pinned_ids.is_none_or(|ids| !ids.contains(hit.id.as_str()));
            if !shared {
                continue;
            }
            if let Some(found) = page.iter().find(|held| held.id == hit.id) {
                hit.highlights = found.highlights.clone();
            }
        }
    }
}
