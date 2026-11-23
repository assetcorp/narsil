use narsil::Value;

use crate::allocator::{Assignment, Table};
use crate::data::writes::AllocationView;
use crate::error::{ClusterError, ClusterResult, codes};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ServedRead {
    Query,
}

struct UnservedPartition {
    partition_id: u32,
    initialising: bool,
}

fn outside_in_sync_set(assignment: &Assignment, node_id: &str) -> bool {
    assignment
        .primary
        .as_deref()
        .is_some_and(|primary| primary != node_id)
        && assignment.replicas.iter().any(|replica| replica == node_id)
        && !assignment
            .in_sync_set
            .iter()
            .any(|replica| replica == node_id)
}

fn unserved_partition(
    table: Option<&Table>,
    partition_ids: &[u32],
    node_id: &str,
    read: ServedRead,
) -> Option<UnservedPartition> {
    let table = table?;
    for &partition_id in partition_ids {
        let Some(assignment) = table.assignments.get(f64::from(partition_id)) else {
            continue;
        };
        if assignment.state == "INITIALISING" {
            return Some(UnservedPartition {
                partition_id,
                initialising: true,
            });
        }
        if read == ServedRead::Query && outside_in_sync_set(assignment, node_id) {
            return Some(UnservedPartition {
                partition_id,
                initialising: false,
            });
        }
    }
    None
}

fn read_refusal(node_id: &str, index_name: &str, unserved: &UnservedPartition) -> ClusterError {
    let partition_id = unserved.partition_id;
    let reason = if unserved.initialising {
        format!("partition {partition_id} of index '{index_name}' is INITIALISING")
    } else {
        format!(
            "its copy of partition {partition_id} of index '{index_name}' is outside the in-sync set"
        )
    };
    ClusterError::new(
        codes::QUERY_NO_ACTIVE_REPLICA,
        format!("Node '{node_id}' serves no read, because {reason}"),
    )
    .with_detail("indexName", Value::String(index_name.to_string()))
    .with_detail("partitionId", Value::from(partition_id))
    .with_detail("nodeId", Value::String(node_id.to_string()))
}

pub(super) async fn refuse_unserved_read(
    view: &AllocationView,
    node_id: &str,
    index_name: &str,
    partition_ids: &[u32],
    read: ServedRead,
) -> ClusterResult<()> {
    let watched_table = view.read(index_name).await.ok().flatten();
    let Some(watched) = unserved_partition(watched_table.as_ref(), partition_ids, node_id, read)
    else {
        return Ok(());
    };
    let live = match view.read_live(index_name).await {
        Ok(live) => live,
        Err(_) => return Err(read_refusal(node_id, index_name, &watched)),
    };
    match unserved_partition(live.as_ref(), partition_ids, node_id, read) {
        Some(confirmed) => Err(read_refusal(node_id, index_name, &confirmed)),
        None => Ok(()),
    }
}
