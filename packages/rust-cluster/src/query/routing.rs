use std::collections::HashSet;
use std::sync::Arc;

use narsil::coordination::{
    CoordinatedCursor, comparable_sort_value, decode_cursor, encode_cursor, query_binding,
    sort_signature,
};
use narsil::{QueryCoverage, ScoringMode, SearchMode, Value};

use super::dfs_stats::collect_distributed_stats;
use super::failover::OutcomeStatus;
use super::fan_out::{
    DistributedQueryConfig, NodeQueryOutcome, SearchFanOut, build_coverage, fan_out_search,
};
use super::group_merge::merge_groups_for;
use super::hybrid::{HybridPage, execute_hybrid_query};
use super::merge::{merge_and_truncate_scored_entries, merge_and_truncate_sorted_entries};
use super::outcomes::{
    answered_of, gather_outcomes, keep_alive_for, merged_facets, refuse_partial,
};
use super::pinning::{PinnedPlacement, last_organic_entry, place_pinned_entries};
use super::search_answer::{ScoredEntry, WireGroupEntry};
use super::search_contexts::{SearchContextSet, collect_search_contexts};
use super::selection::{PartitionRouting, QueryKeyedSelector, select_replicas_for_query};
use super::wire_query::WireQuery;
use crate::constants::{GROUP_OVERSAMPLE_FACTOR, GROUP_OVERSAMPLE_PADDING, MAX_FACET_SIZE};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::reads::list::require_within_result_window;
use crate::reads::preflight::routed_for_versions;
use crate::reads::query_conversion::DistributedFacets;
use crate::reads::{ReadDeps, live_allocation_once};

pub(crate) struct QueryRouting {
    pub(crate) deps: Arc<ReadDeps>,
    pub(crate) carries_bm25: bool,
    pub(crate) pinned_documents: Option<HashSet<String>>,
}

#[derive(Default)]
pub(crate) struct DistributedResult {
    pub(crate) scored: Vec<ScoredEntry>,
    pub(crate) total_hits: u64,
    pub(crate) facets: Option<DistributedFacets>,
    pub(crate) groups: Option<Vec<WireGroupEntry>>,
    pub(crate) cursor: Option<String>,
    pub(crate) coverage: QueryCoverage,
    pub(crate) pinned_from_outside: Vec<String>,
    pub(crate) merge_held_every_match: bool,
    pub(crate) contexts: SearchContextSet,
}

pub(crate) fn oversampled_shard_size(size: usize) -> usize {
    (size as f64 * GROUP_OVERSAMPLE_FACTOR).ceil() as usize + GROUP_OVERSAMPLE_PADDING
}

pub(crate) struct ShardFacets {
    pub(crate) shard_size: Option<usize>,
    pub(crate) size: usize,
}

pub(crate) async fn distributed_query(
    index_name: &str,
    params: &WireQuery,
    routing_deps: &QueryRouting,
    config: &DistributedQueryConfig,
) -> ClusterResult<DistributedResult> {
    let deps = &routing_deps.deps;
    let binding = query_binding(&params.to_local());
    let signature = sort_signature(params.sort_fields())?;
    let cursor = match &params.search_after {
        Some(search_after) => Some(decode_cursor(
            search_after,
            signature.as_deref(),
            true,
            &binding,
        )?),
        None => None,
    };
    require_within_result_window(params.limit, params.offset)?;
    let has_facets = params
        .facets
        .as_ref()
        .is_some_and(|facets| !facets.is_empty());
    let facet_size = params
        .facet_size
        .unwrap_or(config.default_facet_size)
        .clamp(1, MAX_FACET_SIZE);
    let facets = ShardFacets {
        shard_size: has_facets.then(|| oversampled_shard_size(facet_size)),
        size: facet_size,
    };
    let Some(table) = deps.view.read(index_name).await? else {
        return Err(ClusterError::new(
            codes::QUERY_ROUTING_FAILED,
            format!("No allocation table found for index '{index_name}'"),
        )
        .with_detail("indexName", Value::from(index_name)));
    };
    if table.assignments.is_empty() {
        return Ok(DistributedResult::default());
    }
    let selector = QueryKeyedSelector::new(&binding);
    let carries_bm25 = routing_deps.carries_bm25;
    let term = params.term.as_deref();
    let routed = routed_for_versions(deps, index_name, &table, carries_bm25, term).await?;
    let mut routing = select_replicas_for_query(&routed, &selector);
    let mut total_partitions = table.assignments.len();
    if !routing.unavailable_partitions.is_empty()
        && let Some(live) = live_allocation_once(deps, index_name).await
    {
        let routed = routed_for_versions(deps, index_name, &live, carries_bm25, term).await?;
        routing = select_replicas_for_query(&routed, &selector);
        total_partitions = live.assignments.len();
    }
    if !routing.unavailable_partitions.is_empty() && !config.allow_partial_results {
        let mut unavailable = routing.unavailable_partitions.clone();
        unavailable.sort_unstable();
        return Err(ClusterError::new(
            codes::QUERY_PARTIAL_FAILURE,
            "No active replica serves one or more partitions, and this node refuses partial results",
        )
        .with_detail(
            "unavailablePartitions",
            Value::Array(unavailable.into_iter().map(Value::from).collect()),
        ));
    }
    let is_hybrid = params.vector.is_some()
        && (params.term.is_some() || params.mode == Some(SearchMode::Hybrid));
    if is_hybrid && params.search_after.is_some() && params.hybrid.and_then(|h| h.depth).is_none() {
        return Err(ClusterError::new(
            codes::SEARCH_INVALID_CURSOR,
            "Cursor pagination is not supported for hybrid queries without hybrid.depth, because fused ranks do not seek. Set hybrid.depth to page by cursor",
        )
        .with_detail("indexName", Value::from(index_name)));
    }
    if is_hybrid && params.sort_fields().is_some() {
        return Err(ClusterError::new(
            codes::SEARCH_INVALID_MODE,
            "A hybrid query cannot carry a sort, because fusion defines the order of hybrid results",
        )
        .with_detail("indexName", Value::from(index_name)));
    }
    let run = FanOutRun {
        index_name,
        params,
        binding: &binding,
        signature: signature.as_deref(),
        cursor,
        facets,
        total_partitions,
        routing,
    };
    if is_hybrid {
        return execute_hybrid_query(
            run,
            HybridPage {
                limit: params.limit,
                offset: params.offset,
            },
            routing_deps,
            config,
        )
        .await;
    }
    execute_single_fan_out(run, routing_deps, config).await
}

pub(crate) struct FanOutRun<'a> {
    pub(crate) index_name: &'a str,
    pub(crate) params: &'a WireQuery,
    pub(crate) binding: &'a str,
    pub(crate) signature: Option<&'a str>,
    pub(crate) cursor: Option<CoordinatedCursor>,
    pub(crate) facets: ShardFacets,
    pub(crate) total_partitions: usize,
    pub(crate) routing: PartitionRouting,
}

fn fail_outcomes_missing_sort_values(outcomes: &mut [NodeQueryOutcome]) {
    for outcome in outcomes.iter_mut() {
        if outcome.status != OutcomeStatus::Success {
            continue;
        }
        let missing = outcome.results.as_ref().is_some_and(|results| {
            results.results.iter().any(|partition| {
                partition
                    .scored
                    .iter()
                    .any(|entry| entry.sort_values.is_none())
            })
        });
        if missing {
            outcome.status = OutcomeStatus::Failed;
            outcome.results = None;
        }
    }
}

async fn execute_single_fan_out(
    run: FanOutRun<'_>,
    routing_deps: &QueryRouting,
    config: &DistributedQueryConfig,
) -> ClusterResult<DistributedResult> {
    let deps = &routing_deps.deps;
    let params = run.params;
    let global_stats = match params.scoring {
        ScoringMode::Dfs => Some(
            collect_distributed_stats(deps, run.index_name, params, &run.routing, config).await?,
        ),
        _ => None,
    };
    let depth = params.limit + params.offset;
    let sort_fields = params.sort_fields();
    let sorted_groups = params.group.is_some() && sort_fields.is_some();
    let mut search_params = params.clone();
    search_params.limit = depth;
    search_params.offset = 0;
    if sorted_groups {
        search_params.include_scores = Some(true);
    }
    let mut outcomes = fan_out_search(
        deps,
        SearchFanOut {
            index_name: run.index_name,
            params: search_params.to_value(),
            global_stats: global_stats.as_ref().map(|stats| stats.to_value()),
            facet_shard_size: run.facets.shard_size,
            keep_alive_ms: keep_alive_for(deps, &run.routing, config),
        },
        &run.routing,
        config,
    )
    .await?;
    let contexts = collect_search_contexts(answered_of(&outcomes));
    if sort_fields.is_some() {
        fail_outcomes_missing_sort_values(&mut outcomes);
    }
    let coverage = build_coverage(
        run.total_partitions,
        &run.routing.unavailable_partitions,
        &[&outcomes],
    );
    if !config.allow_partial_results {
        refuse_partial(
            deps,
            run.index_name,
            &contexts,
            &coverage,
            "One or more partitions failed during query",
        )?;
    }
    let mut gathered = gather_outcomes(&mut outcomes);
    let scored = std::mem::take(&mut gathered.scored);
    let merged = match sort_fields {
        Some(sort) => {
            let directions: Vec<_> = sort.iter().map(|field| field.direction).collect();
            merge_and_truncate_sorted_entries(scored, depth, &directions)?
        }
        None => merge_and_truncate_scored_entries(scored, depth)?,
    };
    let all_matches_present = coverage.queried_partitions == coverage.total_partitions
        && gathered.total_hits <= merged.len() as u64;
    let placement = match (&params.pinned, &params.search_after) {
        (Some(pinned), None) => place_pinned_entries(
            merged,
            pinned,
            depth,
            all_matches_present,
            routing_deps.pinned_documents.as_ref(),
        )?,
        _ => PinnedPlacement {
            entries: merged,
            placed_from_outside: Vec::new(),
        },
    };
    let merged_scored: Vec<ScoredEntry> = placement
        .entries
        .into_iter()
        .skip(params.offset)
        .take(depth.saturating_sub(params.offset))
        .collect();
    let facets = merged_facets(&gathered, params, run.facets.size)?;
    let groups = merge_groups_for(params, &gathered.groups, sort_fields)?;
    let page_pins = match params.search_after {
        None => params.pinned.as_deref(),
        Some(_) => None,
    };
    let reached_depth = run.cursor.as_ref().map_or(0, |cursor| cursor.depth);
    let next_depth = reached_depth + (params.offset + merged_scored.len()) as u64;
    let cursor = last_organic_entry(&merged_scored, page_pins).map(|last| match sort_fields {
        Some(_) => encode_cursor(CoordinatedCursor {
            anchor: last.doc_id.clone(),
            score: None,
            sort_key: Some(
                last.sort_values
                    .as_deref()
                    .unwrap_or_default()
                    .iter()
                    .map(comparable_sort_value)
                    .collect(),
            ),
            sort_signature: run.signature.map(str::to_string),
            depth: next_depth,
            binding: run.binding.to_string(),
        }),
        None => encode_cursor(CoordinatedCursor {
            anchor: last.doc_id.clone(),
            score: last.score,
            sort_key: None,
            sort_signature: None,
            depth: next_depth,
            binding: run.binding.to_string(),
        }),
    });
    Ok(DistributedResult {
        scored: merged_scored,
        total_hits: gathered.total_hits,
        facets,
        groups,
        cursor,
        coverage,
        pinned_from_outside: placement.placed_from_outside,
        merge_held_every_match: all_matches_present,
        contexts,
    })
}
