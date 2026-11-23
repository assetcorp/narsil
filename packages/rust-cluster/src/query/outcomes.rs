use std::collections::BTreeMap;
use std::sync::Arc;

use narsil::{Map, QueryCoverage, Value};

use super::failover::OutcomeStatus;
use super::fan_out::{DistributedQueryConfig, NodeQueryOutcome};
use super::merge::merge_distributed_facets;
use super::search_answer::{FacetBuckets, ScoredEntry, SearchAnswer, WireGroupEntry};
use super::search_contexts::{
    SearchContextSet, release_search_contexts, search_context_keep_alive,
};
use super::selection::PartitionRouting;
use super::wire_query::WireQuery;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::reads::ReadDeps;
use crate::reads::query_conversion::{DistributedFacets, ascending_facet_fields};

pub(crate) struct Gathered {
    pub(crate) scored: Vec<Vec<ScoredEntry>>,
    pub(crate) facets: Vec<FacetBuckets>,
    pub(crate) facet_bounds: Vec<Option<BTreeMap<String, u64>>>,
    pub(crate) groups: Vec<Vec<WireGroupEntry>>,
    pub(crate) total_hits: u64,
}

pub(crate) fn gather_outcomes(outcomes: &mut [NodeQueryOutcome]) -> Gathered {
    let mut gathered = Gathered {
        scored: Vec::new(),
        facets: Vec::new(),
        facet_bounds: Vec::new(),
        groups: Vec::new(),
        total_hits: 0,
    };
    for outcome in outcomes.iter_mut() {
        if outcome.status != OutcomeStatus::Success {
            continue;
        }
        let Some(results) = outcome.results.as_mut() else {
            continue;
        };
        for partition in &mut results.results {
            gathered.total_hits = gathered.total_hits.saturating_add(partition.total_hits);
            if !partition.scored.is_empty() {
                gathered.scored.push(std::mem::take(&mut partition.scored));
            }
        }
        if let Some(facets) = results.facets.take() {
            gathered.facets.push(facets);
            gathered
                .facet_bounds
                .push(results.facet_error_bounds.take());
        }
        if let Some(groups) = results.groups.take() {
            gathered.groups.push(groups);
        }
    }
    gathered
}

pub(crate) fn answered_of(
    outcomes: &[NodeQueryOutcome],
) -> impl Iterator<Item = (&str, &SearchAnswer)> {
    outcomes.iter().filter_map(|outcome| {
        let results = outcome.results.as_ref()?;
        (outcome.status == OutcomeStatus::Success).then_some((outcome.node_id.as_str(), results))
    })
}

pub(crate) fn refuse_partial(
    deps: &Arc<ReadDeps>,
    index_name: &str,
    contexts: &SearchContextSet,
    coverage: &QueryCoverage,
    message: &str,
) -> ClusterResult<()> {
    if coverage.timed_out_partitions + coverage.failed_partitions == 0 {
        return Ok(());
    }
    release_search_contexts(deps, index_name, &contexts.opened);
    let mut detail = Map::with_capacity(4);
    detail.insert("totalPartitions", Value::from(coverage.total_partitions));
    detail.insert(
        "queriedPartitions",
        Value::from(coverage.queried_partitions),
    );
    detail.insert(
        "timedOutPartitions",
        Value::from(coverage.timed_out_partitions),
    );
    detail.insert("failedPartitions", Value::from(coverage.failed_partitions));
    Err(ClusterError::new(codes::QUERY_PARTIAL_FAILURE, message)
        .with_detail("coverage", Value::Object(detail)))
}

pub(crate) fn keep_alive_for(
    deps: &ReadDeps,
    routing: &PartitionRouting,
    config: &DistributedQueryConfig,
) -> Option<u64> {
    config.search_contexts.then(|| {
        let request_timeout = deps.transport.timeouts().request_timeout.as_millis();
        search_context_keep_alive(
            routing,
            config.partition_timeout_ms,
            u64::try_from(request_timeout).unwrap_or(u64::MAX),
        )
    })
}

pub(crate) fn merged_facets(
    gathered: &Gathered,
    params: &WireQuery,
    facet_size: usize,
) -> ClusterResult<Option<DistributedFacets>> {
    if gathered.facets.is_empty() {
        return Ok(None);
    }
    merge_distributed_facets(
        &gathered.facets,
        &gathered.facet_bounds,
        facet_size,
        &ascending_facet_fields(params.facets.as_deref()),
    )
    .map(Some)
}
