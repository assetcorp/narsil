use std::collections::HashMap;
use std::sync::Arc;

use narsil::{QueryParams, QueryResult};

use super::bm25::{bm25_routing_for, held_bm25_routing_for};
use super::groups::{GroupReads, assemble_distributed_groups};
use super::pinned::{
    count_stored_pins_from_outside, drop_unstored_pinned_entries, read_pin_presence,
};
use super::projection::{
    ResolvedProjection, VectorReadSettings, apply_projection, fetch_fields_for,
    keeps_any_vector_field, resolve_projection,
};
use super::query_conversion::{
    DistributedPage, distributed_count_is_exact, distributed_result_to_local,
};
use super::ranked_documents::{RankedDocumentReader, RankedRead};
use super::routable_allocation::routable_allocation;
use super::{ReadDeps, rerun_on_newer_generation};
use crate::allocator::Table;
use crate::constants::DEFAULT_FACET_SIZE;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::query::fan_out::DistributedQueryConfig;
use crate::query::routing::{QueryRouting, distributed_query};

struct ClusterSearch<'a> {
    index_name: &'a str,
    setting_name: &'a str,
    table: &'a Table,
    settings: &'a VectorReadSettings,
}

async fn rerun_on_lost_context<T, F, Fut>(mut run: F) -> ClusterResult<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = ClusterResult<T>>,
{
    match run().await {
        Err(error) if error.code() == codes::SEARCH_CONTEXT_MISSING => run().await,
        outcome => outcome,
    }
}

pub(crate) async fn query_cluster(
    deps: &Arc<ReadDeps>,
    index_name: &str,
    params: &QueryParams,
    setting_name: &str,
) -> ClusterResult<QueryResult> {
    let table = routable_allocation(deps, index_name).await?;
    rerun_on_newer_generation(deps, index_name, || {
        rerun_on_lost_context(|| async {
            let settings = deps.vector_reads.settings_of(index_name, &table).await?;
            let search = ClusterSearch {
                index_name,
                setting_name,
                table: &table,
                settings: &settings,
            };
            if params.rerank.is_some() {
                return Err(ClusterError::new(
                    codes::RERANK_CONFIG_INVALID,
                    "This cluster node holds no rerank adapters",
                ));
            }
            let mut reader = RankedDocumentReader::new(deps, index_name, &table);
            let answered = search_cluster(deps, &search, params, &mut reader, false).await;
            reader.release();
            answered
        })
    })
    .await
}

async fn search_cluster(
    deps: &Arc<ReadDeps>,
    search: &ClusterSearch<'_>,
    params: &QueryParams,
    reader: &mut RankedDocumentReader,
    reads_later: bool,
) -> ClusterResult<QueryResult> {
    let projection = resolve_projection(params.document.as_ref(), search.settings);
    let vectors = keeps_any_vector_field(&projection, search.settings);
    let projects = projection != ResolvedProjection::Nothing;
    let groups_read = params
        .group
        .as_ref()
        .is_some_and(|group| group.reduce.is_some() || projects);
    let reads_documents = reads_later || projects || groups_read;
    let routing = match held_bm25_routing_for(deps, search.setting_name, params) {
        Some(routing) => routing,
        None => bm25_routing_for(deps, search.setting_name, params).await?,
    };
    let mut wire = routing.wire;
    wire.analysis_generation = Some(match deps.analysis_view.held(search.index_name) {
        Some(generation) => generation,
        None => deps.analysis_view.generation_for(search.index_name).await?,
    });
    let presence = read_pin_presence(deps, search.index_name, params, search.table).await?;
    let query_deps = QueryRouting {
        deps: Arc::clone(deps),
        carries_bm25: routing.carries_bm25,
        pinned_documents: presence.as_ref().map(|presence| presence.placeable()),
    };
    let config = DistributedQueryConfig {
        allow_partial_results: deps.query.allow_partial_results,
        partition_timeout_ms: deps.query.partition_timeout_ms,
        default_facet_size: DEFAULT_FACET_SIZE,
        search_contexts: reads_documents,
    };
    let mut distributed = distributed_query(search.index_name, &wire, &query_deps, &config).await?;
    reader.adopt(std::mem::take(&mut distributed.contexts));
    let mut documents = HashMap::new();
    if projects {
        let ids: Vec<String> = distributed
            .scored
            .iter()
            .map(|entry| entry.doc_id.clone())
            .collect();
        let found = reader
            .read(
                &ids,
                RankedRead {
                    last: !groups_read && !reads_later,
                    fields: fetch_fields_for(&projection),
                    vectors,
                    require_every_partition: false,
                },
            )
            .await?;
        for (document_id, document) in found {
            documents.insert(document_id, apply_projection(document, &projection));
        }
    }
    let scored =
        drop_unstored_pinned_entries(std::mem::take(&mut distributed.scored), presence.as_ref());
    let pins = count_stored_pins_from_outside(&distributed, presence.as_ref());
    let mut count_exact = distributed_count_is_exact(params, &distributed.coverage);
    let mut total_hits = distributed.total_hits;
    if distributed.merge_held_every_match && pins.every_pin_verified {
        total_hits = total_hits.saturating_add(pins.stored);
    } else if pins.stored > 0 || !pins.every_pin_verified {
        count_exact = false;
    }
    let mut result = distributed_result_to_local(
        DistributedPage {
            scored: &scored,
            total_hits,
            cursor: distributed.cursor.take(),
            facets: distributed.facets.as_ref(),
            coverage: distributed.coverage,
        },
        count_exact,
        &documents,
        params.facets.as_deref(),
    );
    let groups = assemble_distributed_groups(
        params,
        distributed.groups.as_deref(),
        &projection,
        reader,
        GroupReads {
            vectors,
            reads_later,
        },
    )
    .await?;
    if groups.is_some() {
        result.groups = groups;
    }
    if wire.sort_fields().is_some() && params.include_scores != Some(true) {
        for hit in &mut result.hits {
            hit.score = None;
        }
        for group in result.groups.iter_mut().flatten() {
            for hit in &mut group.hits {
                hit.score = None;
            }
        }
    }
    Ok(result)
}
