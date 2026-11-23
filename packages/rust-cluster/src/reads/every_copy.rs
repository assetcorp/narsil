use std::collections::BTreeMap;
use std::sync::Arc;

use tokio::task::JoinSet;

use super::ReadDeps;
use super::counts::{GatheredCounts, count_payload};
use super::node_messaging::request;
use super::scatter::send_read_request;
use crate::allocator::Table;
use crate::error::ClusterResult;
use crate::message::{TransportMessage, message_types};
use crate::query::failover::Failure;
use crate::query::results::{CountResult, PartitionCountEntry, validate_count_result_payload};
use crate::query::selection::partition_id_of;

pub(super) type CopiesByPartition = BTreeMap<u32, Vec<PartitionCountEntry>>;

pub(super) fn count_request(
    deps: &ReadDeps,
    index_name: &str,
    partition_ids: &[u32],
    every_copy: bool,
) -> ClusterResult<TransportMessage> {
    request(
        deps,
        message_types::QUERY_COUNT,
        &count_payload(index_name, partition_ids, every_copy),
    )
}

fn other_copies_by_node(table: &Table, read_by: &BTreeMap<u32, String>) -> Vec<(String, Vec<u32>)> {
    let mut by_node: Vec<(String, Vec<u32>)> = Vec::new();
    for (partition_id, assignment) in table.assignments.iter() {
        let partition_id = partition_id_of(partition_id);
        let mut copies: Vec<&String> = Vec::new();
        for replica in &assignment.replicas {
            if !copies.contains(&replica) {
                copies.push(replica);
            }
        }
        if let Some(primary) = &assignment.primary
            && !copies.contains(&primary)
        {
            copies.push(primary);
        }
        for node_id in copies {
            if read_by.get(&partition_id) == Some(node_id) {
                continue;
            }
            match by_node.iter_mut().find(|(held, _)| held == node_id) {
                Some((_, partition_ids)) => partition_ids.push(partition_id),
                None => by_node.push((node_id.clone(), vec![partition_id])),
            }
        }
    }
    by_node
}

async fn answer_of(
    deps: &ReadDeps,
    index_name: &str,
    node_id: &str,
    partition_ids: &[u32],
) -> Result<CountResult, Failure> {
    let message = count_request(deps, index_name, partition_ids, true)?;
    send_read_request(
        deps,
        node_id,
        &message,
        index_name,
        validate_count_result_payload,
    )
    .await
}

fn add_answer(copies: &mut CopiesByPartition, partition_ids: &[u32], answer: CountResult) -> bool {
    let mut answered: BTreeMap<u32, PartitionCountEntry> = answer
        .partitions
        .into_iter()
        .map(|entry| (entry.partition_id, entry))
        .collect();
    for partition_id in partition_ids {
        let Some(entry) = answered.remove(partition_id) else {
            return false;
        };
        if let Some(held) = copies.get_mut(partition_id) {
            held.push(entry);
        }
    }
    true
}

pub(super) async fn counts_of_every_copy(
    deps: &Arc<ReadDeps>,
    index_name: &str,
    table: &Table,
    gathered: &GatheredCounts,
) -> Option<CopiesByPartition> {
    let mut copies: CopiesByPartition = gathered
        .counts_by_partition
        .iter()
        .map(|(partition_id, entry)| (*partition_id, vec![entry.clone()]))
        .collect();
    let mut requests = JoinSet::new();
    for (node_id, partition_ids) in other_copies_by_node(table, &gathered.read_by) {
        let deps = Arc::clone(deps);
        let index_name = index_name.to_string();
        requests.spawn(async move {
            let answer = answer_of(&deps, &index_name, &node_id, &partition_ids).await;
            (partition_ids, answer)
        });
    }
    let mut answers = Vec::new();
    while let Some(joined) = requests.join_next().await {
        match joined {
            Ok((partition_ids, Ok(answer))) => answers.push((partition_ids, answer)),
            _ => return None,
        }
    }
    for (partition_ids, answer) in answers {
        if !add_answer(&mut copies, &partition_ids, answer) {
            return None;
        }
    }
    Some(copies)
}

pub(super) fn sum_of<'a>(
    entries: impl IntoIterator<Item = &'a PartitionCountEntry>,
    figure: impl Fn(&PartitionCountEntry) -> Option<u64>,
) -> Option<u64> {
    let mut total: u64 = 0;
    for entry in entries {
        total = total.saturating_add(figure(entry)?);
    }
    Some(total)
}

pub(super) fn saved_bytes_with_vectors(entry: &PartitionCountEntry) -> Option<u64> {
    Some(entry.saved_bytes?.saturating_add(entry.vector_saved_bytes?))
}
