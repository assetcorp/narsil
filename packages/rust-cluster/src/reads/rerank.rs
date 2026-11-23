use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;

use narsil::coordination::{
    RerankHost, check_rerank, decode_cursor, hybrid_depth, page_hits_by_position,
    place_pinned_hits, query_binding, reorder_hits_by_rerank, rerank_first_stage_depth,
    rerank_text,
};
use narsil::{
    DocumentProjection, GroupResult, Hit, Map, Pin, QueryParams, QueryResult, SearchMode,
};

use super::ReadDeps;
use super::projection::{
    ResolvedProjection, apply_projection, keeps_any_vector_field, resolve_projection,
};
use super::ranked_documents::{RankedDocumentReader, RankedRead};
use super::search::{ClusterSearch, search_cluster};
use crate::constants::DEFAULT_PAGE_SIZE;
use crate::error::{ClusterError, ClusterResult, codes};

fn text_read() -> RankedRead {
    RankedRead {
        last: false,
        fields: None,
        vectors: false,
        require_every_partition: true,
    }
}

fn fuses_rankings(params: &QueryParams) -> bool {
    params.vector.is_some() && (params.term.is_some() || params.mode == Some(SearchMode::Hybrid))
}

fn deduped_ids(pins: &[Pin]) -> Vec<String> {
    let mut ids: Vec<String> = Vec::with_capacity(pins.len());
    for pin in pins {
        if !ids.contains(&pin.doc_id) {
            ids.push(pin.doc_id.clone());
        }
    }
    ids
}

async fn rerank_scores(
    host: &Arc<RerankHost>,
    adapter: &str,
    query: &str,
    documents: Vec<String>,
) -> ClusterResult<Vec<f64>> {
    let host = Arc::clone(host);
    let (adapter, query) = (adapter.to_string(), query.to_string());
    let scored = tokio::task::spawn_blocking(move || host.score(&adapter, &query, documents))
        .await
        .map_err(|_| {
            ClusterError::new(
                codes::INTERNAL_ERROR,
                "A rerank adapter call stopped before it finished",
            )
        })?;
    Ok(scored?)
}

async fn fill_documents(
    reader: &mut RankedDocumentReader,
    page: &mut [Hit],
    groups: Option<&mut Vec<GroupResult>>,
    projection: &ResolvedProjection,
    vectors: bool,
) -> ClusterResult<()> {
    let mut grouped: Vec<&mut Hit> = match groups {
        Some(groups) => groups
            .iter_mut()
            .flat_map(|group| group.hits.iter_mut())
            .collect(),
        None => Vec::new(),
    };
    if *projection == ResolvedProjection::Nothing {
        for hit in page.iter_mut() {
            hit.document = Map::new();
        }
        for hit in grouped.iter_mut() {
            hit.document = Map::new();
        }
        return Ok(());
    }
    let ids: Vec<String> = page
        .iter()
        .map(|hit| hit.id.clone())
        .chain(grouped.iter().map(|hit| hit.id.clone()))
        .collect();
    let documents = reader
        .read(
            &ids,
            RankedRead {
                last: true,
                fields: None,
                vectors,
                require_every_partition: true,
            },
        )
        .await?;
    let read = |id: &str| -> Map {
        documents
            .get(id)
            .map(|document| apply_projection(document.clone(), projection))
            .unwrap_or_default()
    };
    for hit in page.iter_mut() {
        hit.document = read(&hit.id);
    }
    for hit in grouped.iter_mut() {
        hit.document = read(&hit.id);
    }
    Ok(())
}

pub(super) async fn rerank_cluster_query(
    deps: &Arc<ReadDeps>,
    search: &ClusterSearch<'_>,
    params: &QueryParams,
    reader: &mut RankedDocumentReader,
) -> ClusterResult<QueryResult> {
    let started = Instant::now();
    let fuses = fuses_rankings(params);
    let hybrid = match fuses {
        true => hybrid_depth(params.hybrid.as_ref())?,
        false => None,
    };
    let plan = check_rerank(
        params,
        &search.settings.schema,
        hybrid,
        deps.rerank.max_window(),
    )?;
    let limit = params.limit.unwrap_or(DEFAULT_PAGE_SIZE);
    let offset = params.offset.unwrap_or(0);
    let binding = query_binding(params);
    let cursor_depth = match params.search_after.as_deref() {
        Some(cursor) => {
            let decoded = decode_cursor(cursor, None, true, &binding)?;
            usize::try_from(decoded.depth).unwrap_or(usize::MAX)
        }
        None => 0,
    };
    let depth = rerank_first_stage_depth(hybrid, plan.window, cursor_depth, offset, limit)?;
    let projection = resolve_projection(params.document.as_ref(), search.settings);
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
    let mut first = search_cluster(deps, search, &first_params, reader, true).await?;
    let plain = match counts_apart {
        true => {
            let mut plain_params = first_params.clone();
            if places_pins {
                plain_params.pinned = params.pinned.clone();
            }
            plain_params.facets = None;
            plain_params.group = None;
            plain_params.offset = Some(cursor_depth + offset);
            plain_params.limit = Some(limit);
            Some(search_cluster(deps, search, &plain_params, reader, true).await?)
        }
        false => None,
    };
    let ranked = std::mem::take(&mut first.hits);
    let pins = match params.pinned.as_deref().filter(|_| places_pins) {
        Some(pins) => {
            let stored: HashSet<String> = reader
                .read(&deduped_ids(pins), text_read())
                .await?
                .into_keys()
                .collect();
            let clamps = first.count_exact && ranked.len() as u64 >= first.count;
            Some(
                pins.iter()
                    .filter(|pin| stored.contains(&pin.doc_id) && (clamps || pin.position < depth))
                    .cloned()
                    .collect::<Vec<Pin>>(),
            )
        }
        None => None,
    };
    let start = cursor_depth + offset;
    let window_size = plan.window.min(ranked.len());
    let page_holds_hits = limit > 0 && start < place_pinned_hits(&ranked, pins.as_deref())?.len();
    let ordered = match window_size > 0 && page_holds_hits {
        true => {
            let window_ids: Vec<String> = ranked
                .iter()
                .take(window_size)
                .map(|hit| hit.id.clone())
                .collect();
            let documents: HashMap<String, Map> = reader.read(&window_ids, text_read()).await?;
            let texts = window_ids
                .iter()
                .map(|id| {
                    documents
                        .get(id)
                        .map(|document| rerank_text(document, &plan.fields))
                        .unwrap_or_default()
                })
                .collect();
            let scores = rerank_scores(&deps.rerank, &plan.adapter, &plan.query, texts).await?;
            reorder_hits_by_rerank(ranked, window_size, &scores)
        }
        false => {
            rerank_scores(&deps.rerank, &plan.adapter, &plan.query, Vec::new()).await?;
            ranked
        }
    };
    let placed = place_pinned_hits(&ordered, pins.as_deref())?;
    let pinned_ids: Option<HashSet<&str>> = pins
        .as_ref()
        .map(|pins| pins.iter().map(|pin| pin.doc_id.as_str()).collect());
    let organic: Vec<&str> = ordered.iter().map(|hit| hit.id.as_str()).collect();
    let (range, cursor) = page_hits_by_position(
        &placed,
        &organic,
        start,
        limit,
        pinned_ids.as_ref(),
        &binding,
    );
    let mut page: Vec<Hit> = placed[range].to_vec();
    let vectors = keeps_any_vector_field(&projection, search.settings);
    fill_documents(
        reader,
        &mut page,
        first.groups.as_mut(),
        &projection,
        vectors,
    )
    .await?;
    let (count, count_exact) = match &plain {
        Some(plain) => (plain.count, plain.count_exact),
        None => (first.count, first.count_exact),
    };
    Ok(QueryResult {
        hits: page,
        count,
        count_exact,
        elapsed: started.elapsed(),
        cursor,
        facets: first.facets,
        groups: first.groups,
        analysis_stale: false,
        coverage: first.coverage,
    })
}
