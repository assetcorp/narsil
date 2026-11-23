use std::collections::HashSet;

use narsil::coordination::{
    HYBRID_VECTOR_RESCORE_WINDOW, fuse_hybrid_rankings, hybrid_depth, page_hybrid_by_position,
    require_hybrid_page_within, resolve_hybrid_fusion,
};
use narsil::{Pin, ScoringMode};

use super::dfs_stats::collect_distributed_stats;
use super::fan_out::{DistributedQueryConfig, SearchFanOut, build_coverage, fan_out_search};
use super::group_merge::merge_groups_for;
use super::merge::merge_and_truncate_scored_entries;
use super::outcomes::{
    answered_of, gather_outcomes, keep_alive_for, merged_facets, refuse_partial,
};
use super::pinning::{PinnedPlacement, place_pinned_entries};
use super::routing::{DistributedResult, FanOutRun, QueryRouting};
use super::search_answer::ScoredEntry;
use super::search_contexts::{collect_search_contexts, release_search_contexts};
use super::wire_query::{WireQuery, WireVector};
use crate::error::ClusterResult;

pub(crate) struct HybridPage {
    pub(crate) limit: usize,
    pub(crate) offset: usize,
}

fn page_legs_of(params: &WireQuery, depth: usize) -> (WireQuery, WireQuery) {
    let mut text = params.clone();
    text.vector = None;
    text.hybrid = None;
    text.mode = None;
    text.limit = depth;
    text.offset = 0;
    let mut vector = params.clone();
    vector.term = None;
    vector.hybrid = None;
    vector.mode = None;
    vector.group = None;
    vector.facets = None;
    vector.facet_size = None;
    vector.limit = depth;
    vector.offset = 0;
    (text, vector)
}

fn fixed_legs_of(params: &WireQuery, depth: usize) -> (WireQuery, WireQuery) {
    let mut legs = params.clone();
    legs.hybrid = None;
    legs.mode = None;
    legs.sort = None;
    legs.search_after = None;
    legs.pinned = None;
    legs.limit = depth;
    legs.offset = 0;
    let mut text = legs.clone();
    text.vector = None;
    let mut vector = legs;
    vector.vector = vector.vector.map(|leg| WireVector {
        query: leg.query,
        rescore_window: Some(HYBRID_VECTOR_RESCORE_WINDOW),
    });
    vector.term = None;
    vector.group = None;
    vector.facets = None;
    vector.facet_size = None;
    (text, vector)
}

fn ranking_of(entries: &[ScoredEntry]) -> Vec<(String, Option<f64>)> {
    entries
        .iter()
        .map(|entry| (entry.doc_id.clone(), entry.score))
        .collect()
}

struct FixedDepthPage<'a> {
    placed: &'a [ScoredEntry],
    fused: &'a [ScoredEntry],
    pins: Option<&'a [Pin]>,
    all_matches_present: bool,
    start: usize,
    limit: usize,
    depth: usize,
    binding: &'a str,
}

fn page_fixed_depth(page: FixedDepthPage<'_>) -> (Vec<ScoredEntry>, Option<String>) {
    let placed_ids: Option<HashSet<&str>> = page.pins.map(|pins| {
        pins.iter()
            .filter(|pin| page.all_matches_present || pin.position < page.depth)
            .map(|pin| pin.doc_id.as_str())
            .collect()
    });
    let organic: Vec<&str> = page
        .fused
        .iter()
        .map(|entry| entry.doc_id.as_str())
        .collect();
    let paged = page_hybrid_by_position(
        &ranking_of(page.placed),
        &organic,
        page.start,
        page.limit,
        placed_ids.as_ref(),
        page.binding,
    );
    (page.placed[paged.range].to_vec(), paged.cursor)
}

pub(crate) async fn execute_hybrid_query(
    run: FanOutRun<'_>,
    page: HybridPage,
    routing_deps: &QueryRouting,
    config: &DistributedQueryConfig,
) -> ClusterResult<DistributedResult> {
    let deps = &routing_deps.deps;
    let params = run.params;
    let fusion = resolve_hybrid_fusion(params.hybrid.as_ref())?;
    let fixed_depth = hybrid_depth(params.hybrid.as_ref())?;
    let cursor_depth = match (fixed_depth, &run.cursor) {
        (Some(_), Some(cursor)) => usize::try_from(cursor.depth).unwrap_or(usize::MAX),
        _ => 0,
    };
    if let Some(fixed_depth) = fixed_depth {
        require_hybrid_page_within(cursor_depth, page.offset, fixed_depth)?;
    }
    let depth = fixed_depth.unwrap_or(page.limit + page.offset);
    let (text_params, vector_params) = match fixed_depth {
        None => page_legs_of(params, depth),
        Some(_) => fixed_legs_of(params, depth),
    };
    let text_stats = match params.scoring {
        ScoringMode::Dfs => Some(
            collect_distributed_stats(deps, run.index_name, &text_params, &run.routing, config)
                .await?,
        ),
        _ => None,
    };
    let keep_alive_ms = keep_alive_for(deps, &run.routing, config);
    let (text_leg, vector_leg) = tokio::join!(
        fan_out_search(
            deps,
            SearchFanOut {
                index_name: run.index_name,
                params: text_params.to_value(),
                global_stats: text_stats.as_ref().map(|stats| stats.to_value()),
                facet_shard_size: run.facets.shard_size,
                keep_alive_ms,
            },
            &run.routing,
            config,
        ),
        fan_out_search(
            deps,
            SearchFanOut {
                index_name: run.index_name,
                params: vector_params.to_value(),
                global_stats: None,
                facet_shard_size: None,
                keep_alive_ms,
            },
            &run.routing,
            config,
        ),
    );
    let answered = text_leg
        .iter()
        .chain(vector_leg.iter())
        .flat_map(|outcomes| answered_of(outcomes));
    let contexts = collect_search_contexts(answered);
    let (mut text_outcomes, mut vector_outcomes) = match (text_leg, vector_leg) {
        (Ok(text), Ok(vector)) => (text, vector),
        (Err(error), _) | (_, Err(error)) => {
            release_search_contexts(deps, run.index_name, &contexts.opened);
            return Err(error);
        }
    };
    let coverage = build_coverage(
        run.total_partitions,
        &run.routing.unavailable_partitions,
        &[&text_outcomes, &vector_outcomes],
    );
    if !config.allow_partial_results {
        refuse_partial(
            deps,
            run.index_name,
            &contexts,
            &coverage,
            "One or more partitions failed during hybrid query",
        )?;
    }
    let mut text = gather_outcomes(&mut text_outcomes);
    let mut vector = gather_outcomes(&mut vector_outcomes);
    let merged_text = merge_and_truncate_scored_entries(std::mem::take(&mut text.scored), depth)?;
    let merged_vector =
        merge_and_truncate_scored_entries(std::mem::take(&mut vector.scored), depth)?;
    let mut fused: Vec<ScoredEntry> = fuse_hybrid_rankings(
        fusion,
        &ranking_of(&merged_text),
        &ranking_of(&merged_vector),
    )?
    .into_iter()
    .map(|(doc_id, score)| ScoredEntry {
        doc_id,
        score: Some(score),
        sort_values: None,
    })
    .collect();
    if fixed_depth.is_some() {
        fused.truncate(depth);
    }
    let all_matches_present = coverage.queried_partitions == coverage.total_partitions
        && text.total_hits <= merged_text.len() as u64
        && match fixed_depth {
            None => merged_vector.len() < depth,
            Some(_) => {
                params
                    .vector
                    .as_ref()
                    .is_some_and(|vector| vector.query.similarity.is_none())
                    && vector.total_hits <= merged_vector.len() as u64
            }
        };
    let pins = match (fixed_depth, &params.search_after) {
        (None, _) | (_, None) => params.pinned.as_deref(),
        _ => None,
    };
    let placement = match pins {
        Some(pins) => place_pinned_entries(
            fused.clone(),
            pins,
            depth,
            all_matches_present,
            routing_deps.pinned_documents.as_ref(),
        )?,
        None => PinnedPlacement {
            entries: fused.clone(),
            placed_from_outside: Vec::new(),
        },
    };
    let (scored, cursor) = match fixed_depth {
        None => (
            placement
                .entries
                .iter()
                .skip(page.offset)
                .take(depth.saturating_sub(page.offset))
                .cloned()
                .collect(),
            None,
        ),
        Some(_) => page_fixed_depth(FixedDepthPage {
            placed: &placement.entries,
            fused: &fused,
            pins,
            all_matches_present,
            start: cursor_depth + page.offset,
            limit: page.limit,
            depth,
            binding: run.binding,
        }),
    };
    Ok(DistributedResult {
        scored,
        total_hits: text.total_hits,
        facets: merged_facets(&text, params, run.facets.size)?,
        groups: merge_groups_for(params, &text.groups, None)?,
        cursor,
        coverage,
        pinned_from_outside: placement.placed_from_outside,
        merge_held_every_match: all_matches_present,
        contexts,
    })
}
