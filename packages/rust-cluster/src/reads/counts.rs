use std::collections::BTreeMap;
use std::sync::Arc;

use narsil::{Map, Value};

use super::ReadDeps;
use super::every_copy::{count_request, counts_of_every_copy, saved_bytes_with_vectors, sum_of};
use super::routable_allocation::routable_allocation;
use super::scatter::{gather_from_every_partition, send_read_request};
use crate::allocator::Table;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::query::failover::Failure;
use crate::query::results::{PartitionCountEntry, validate_count_result_payload};
use crate::query::selection::partition_id_of;

/// The figures that [`ClusterNode::get_stats`](crate::node::ClusterNode::get_stats) reports for one index, summed
/// over one copy of each partition, with the saved and log sizes of every copy where every copy answered.
#[derive(Debug, Clone, PartialEq)]
pub struct ClusterIndexStats {
    /// The number of live documents that the index holds.
    pub document_count: u64,
    /// The number of partitions that the index spreads its documents across.
    pub partition_count: usize,
    /// The heap bytes that the copies the node read hold, by their nodes' estimates.
    pub estimated_memory_bytes: u64,
    /// The saved bytes of the copies that the node read, vector files included, or `None` where a copy reports none.
    pub saved_bytes: Option<u64>,
    /// The log bytes of the copies that the node read, or `None` where a copy reports none.
    pub log_bytes: Option<u64>,
    /// The saved bytes of every copy that the allocation table lists, or `None` where a copy failed to answer or
    /// reports none.
    pub saved_bytes_of_every_copy: Option<u64>,
    /// The log bytes of every copy that the allocation table lists, or `None` where a copy failed to answer or
    /// reports none.
    pub log_bytes_of_every_copy: Option<u64>,
    /// The language that analyses the index's text.
    pub language: String,
    /// The index's schema, as the cluster stores it.
    pub schema: Value,
}

/// The figures that [`ClusterNode::get_partition_stats`](crate::node::ClusterNode::get_partition_stats) reports for
/// one partition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClusterPartitionStats {
    /// The partition's id.
    pub partition_id: u32,
    /// The number of live documents that the copy the node read holds.
    pub document_count: u64,
    /// The heap bytes that the copy the node read holds, by its node's estimate.
    pub estimated_memory_bytes: u64,
    /// The saved bytes of the copy that the node read, or `None` where it reports none.
    pub saved_bytes: Option<u64>,
    /// The log bytes of the copy that the node read, or `None` where it reports none.
    pub log_bytes: Option<u64>,
    /// The saved bytes of every copy of the partition, or `None` where a copy failed to answer or reports none.
    pub saved_bytes_of_every_copy: Option<u64>,
    /// The log bytes of every copy of the partition, or `None` where a copy failed to answer or reports none.
    pub log_bytes_of_every_copy: Option<u64>,
}

pub(super) struct GatheredCounts {
    pub(super) counts_by_partition: BTreeMap<u32, PartitionCountEntry>,
    pub(super) read_by: BTreeMap<u32, String>,
    pub(super) language: String,
}

async fn gather_partition_counts(
    deps: &Arc<ReadDeps>,
    index_name: &str,
    table: &Table,
) -> ClusterResult<GatheredCounts> {
    let scatter_deps = Arc::clone(deps);
    let index: Arc<str> = Arc::from(index_name);
    let gathered = gather_from_every_partition(
        deps,
        table,
        index_name,
        move |group| {
            let deps = Arc::clone(&scatter_deps);
            let index = Arc::clone(&index);
            async move {
                let message = count_request(&deps, &index, &group.partition_ids, false)?;
                let answer = send_read_request(
                    &deps,
                    &group.node_id,
                    &message,
                    &index,
                    validate_count_result_payload,
                )
                .await?;
                Ok::<_, Failure>((group.node_id, answer))
            }
        },
        true,
    )
    .await
    .map_err(|failure| failure.error)?;
    let mut counts_by_partition = BTreeMap::new();
    let mut read_by = BTreeMap::new();
    let mut language = String::new();
    for (node_id, answer) in gathered {
        if language.is_empty() {
            language = answer.language;
        }
        for partition in answer.partitions {
            read_by.insert(partition.partition_id, node_id.clone());
            counts_by_partition.insert(partition.partition_id, partition);
        }
    }
    let mut missing: Vec<u32> = table
        .assignments
        .ids()
        .into_iter()
        .map(partition_id_of)
        .filter(|partition_id| !counts_by_partition.contains_key(partition_id))
        .collect();
    if !missing.is_empty() {
        missing.sort_unstable();
        return Err(ClusterError::new(
            codes::QUERY_PARTIAL_FAILURE,
            format!(
                "No node answered the count for one or more partitions of index '{index_name}'"
            ),
        )
        .with_detail("indexName", Value::from(index_name))
        .with_detail(
            "partitionIds",
            Value::Array(missing.into_iter().map(Value::from).collect()),
        ));
    }
    Ok(GatheredCounts {
        counts_by_partition,
        read_by,
        language,
    })
}

pub(crate) async fn count_cluster(deps: &Arc<ReadDeps>, index_name: &str) -> ClusterResult<u64> {
    let table = routable_allocation(deps, index_name).await?;
    let gathered = gather_partition_counts(deps, index_name, &table).await?;
    Ok(gathered
        .counts_by_partition
        .values()
        .map(|entry| entry.document_count)
        .fold(0u64, u64::saturating_add))
}

pub(crate) async fn stats_cluster(
    deps: &Arc<ReadDeps>,
    index_name: &str,
) -> ClusterResult<ClusterIndexStats> {
    let table = routable_allocation(deps, index_name).await?;
    let Some(schema) = deps.coordinator.schema(index_name).await? else {
        return Err(ClusterError::new(
            codes::INDEX_NOT_FOUND,
            format!("Index '{index_name}' has no schema in the cluster"),
        )
        .with_detail("indexName", Value::from(index_name)));
    };
    let gathered = gather_partition_counts(deps, index_name, &table).await?;
    let every_copy = counts_of_every_copy(deps, index_name, &table, &gathered).await;
    let counts = &gathered.counts_by_partition;
    let all_copies: Option<Vec<&PartitionCountEntry>> = every_copy
        .as_ref()
        .map(|copies| copies.values().flatten().collect());
    Ok(ClusterIndexStats {
        document_count: counts
            .values()
            .map(|entry| entry.document_count)
            .fold(0, u64::saturating_add),
        partition_count: table.assignments.len(),
        estimated_memory_bytes: counts
            .values()
            .map(|entry| entry.estimated_memory_bytes)
            .fold(0, u64::saturating_add),
        saved_bytes: sum_of(counts.values(), saved_bytes_with_vectors),
        log_bytes: sum_of(counts.values(), |entry| entry.log_bytes),
        saved_bytes_of_every_copy: all_copies
            .as_ref()
            .and_then(|copies| sum_of(copies.iter().copied(), saved_bytes_with_vectors)),
        log_bytes_of_every_copy: all_copies
            .as_ref()
            .and_then(|copies| sum_of(copies.iter().copied(), |entry| entry.log_bytes)),
        language: gathered.language,
        schema,
    })
}

pub(crate) async fn partition_stats_cluster(
    deps: &Arc<ReadDeps>,
    index_name: &str,
) -> ClusterResult<Vec<ClusterPartitionStats>> {
    let table = routable_allocation(deps, index_name).await?;
    let gathered = gather_partition_counts(deps, index_name, &table).await?;
    let every_copy = counts_of_every_copy(deps, index_name, &table, &gathered).await;
    Ok(gathered
        .counts_by_partition
        .iter()
        .map(|(partition_id, entry)| {
            let copies = every_copy
                .as_ref()
                .and_then(|copies| copies.get(partition_id));
            ClusterPartitionStats {
                partition_id: *partition_id,
                document_count: entry.document_count,
                estimated_memory_bytes: entry.estimated_memory_bytes,
                saved_bytes: entry.saved_bytes,
                log_bytes: entry.log_bytes,
                saved_bytes_of_every_copy: copies
                    .and_then(|copies| sum_of(copies.iter(), |copy| copy.saved_bytes)),
                log_bytes_of_every_copy: copies
                    .and_then(|copies| sum_of(copies.iter(), |copy| copy.log_bytes)),
            }
        })
        .collect())
}

pub(super) fn count_payload(index_name: &str, partition_ids: &[u32], every_copy: bool) -> Map {
    let mut payload = Map::with_capacity(3);
    payload.insert("indexName", Value::from(index_name));
    payload.insert(
        "partitionIds",
        Value::Array(partition_ids.iter().map(|id| Value::from(*id)).collect()),
    );
    if every_copy {
        payload.insert("everyCopy", Value::Bool(true));
    }
    payload
}
