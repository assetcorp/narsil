use std::sync::Arc;
use std::time::Instant;

use narsil::{Map, PreflightResult, QueryParams, Value};

use super::bm25::bm25_routing_for;
use super::node_messaging::request;
use super::query_conversion::count_is_exact_for;
use super::routable_allocation::routable_allocation;
use super::scatter::{gather_from_every_partition, send_read_request};
use super::{ReadDeps, rerun_on_newer_generation};
use crate::allocator::Table;
use crate::error::ClusterResult;
use crate::message::message_types;
use crate::query::results::validate_preflight_result_payload;
use crate::query::version_routing::{
    allocation_for_bm25_query, allocation_for_phrase_query, query_reads_phrases,
};

pub(crate) async fn routed_for_versions(
    deps: &ReadDeps,
    index_name: &str,
    table: &Table,
    carries_bm25: bool,
    term: Option<&str>,
) -> ClusterResult<Table> {
    let reads_phrases = query_reads_phrases(term);
    if !carries_bm25 && !reads_phrases {
        return Ok(table.clone());
    }
    let nodes = deps.coordinator.list_nodes().await?;
    let bm25_table = match carries_bm25 {
        true => allocation_for_bm25_query(index_name, table, &nodes)?,
        false => table.clone(),
    };
    match reads_phrases {
        true => allocation_for_phrase_query(index_name, &bm25_table, &nodes),
        false => Ok(bm25_table),
    }
}

pub(crate) async fn preflight_cluster(
    deps: &Arc<ReadDeps>,
    index_name: &str,
    params: &QueryParams,
    setting_name: &str,
) -> ClusterResult<PreflightResult> {
    let table = routable_allocation(deps, index_name).await?;
    let start_time = Instant::now();
    let index: Arc<str> = Arc::from(index_name);
    let gathered = rerun_on_newer_generation(deps, index_name, || {
        let deps = Arc::clone(deps);
        let index = Arc::clone(&index);
        let table = &table;
        async move {
            let routing = bm25_routing_for(&deps, setting_name, params).await?;
            let mut wire = routing.wire;
            wire.analysis_generation = Some(deps.analysis_view.generation_for(&index).await?);
            let routed = routed_for_versions(
                &deps,
                &index,
                table,
                routing.carries_bm25,
                params.term.as_deref(),
            )
            .await?;
            let wire_params = Arc::new(wire.to_value());
            let scatter_deps = Arc::clone(&deps);
            let scatter_index = Arc::clone(&index);
            gather_from_every_partition(
                &deps,
                &routed,
                &scatter_index,
                move |group| {
                    let deps = Arc::clone(&scatter_deps);
                    let index = Arc::clone(&index);
                    let wire_params = Arc::clone(&wire_params);
                    async move {
                        let mut payload = Map::with_capacity(3);
                        payload.insert("indexName", Value::from(&*index));
                        payload.insert(
                            "partitionIds",
                            Value::Array(
                                group
                                    .partition_ids
                                    .iter()
                                    .map(|id| Value::from(*id))
                                    .collect(),
                            ),
                        );
                        payload.insert("params", (*wire_params).clone());
                        let message = request(&deps, message_types::QUERY_PREFLIGHT, &payload)?;
                        send_read_request(
                            &deps,
                            &group.node_id,
                            &message,
                            &index,
                            validate_preflight_result_payload,
                        )
                        .await
                    }
                },
                false,
            )
            .await
            .map_err(|failure| failure.error)
        }
    })
    .await?;
    let mut count = 0u64;
    let mut analysis_stale = false;
    for answer in gathered {
        count = count.saturating_add(answer.count);
        analysis_stale = analysis_stale || answer.analysis_stale;
    }
    Ok(PreflightResult {
        count,
        count_exact: count_is_exact_for(params),
        elapsed: start_time.elapsed(),
        analysis_stale,
    })
}
