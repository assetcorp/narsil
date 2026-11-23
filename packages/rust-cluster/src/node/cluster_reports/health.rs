use std::collections::HashSet;

use super::tables::{ServedIndex, in_sync_replicas_of, served_indexes};
use super::types::{ClusterHealth, HealthStatus, IndexHealth};
use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::ClusterResult;

const ACTIVE_STATE: &str = "ACTIVE";

fn health_of(index: ServedIndex, registered: &HashSet<String>) -> IndexHealth {
    let mut partitions_without_primary = 0u64;
    let mut under_replicated_partitions = 0u64;
    match &index.table {
        None => partitions_without_primary = index.partition_count as u64,
        Some(table) => {
            for assignment in table.assignments.values() {
                let live_primary = assignment
                    .primary
                    .as_ref()
                    .is_some_and(|primary| registered.contains(primary));
                if !live_primary {
                    partitions_without_primary += 1;
                    continue;
                }
                let live_in_sync = in_sync_replicas_of(assignment)
                    .filter(|replica| registered.contains(*replica))
                    .count();
                if assignment.state != ACTIVE_STATE
                    || (live_in_sync as f64) < table.replication_factor
                {
                    under_replicated_partitions += 1;
                }
            }
        }
    }
    let status = if partitions_without_primary > 0 {
        HealthStatus::Red
    } else if under_replicated_partitions > 0 {
        HealthStatus::Yellow
    } else {
        HealthStatus::Green
    };
    IndexHealth {
        index_name: index.index_name,
        status,
        partition_count: index.partition_count,
        replication_factor: index.replication_factor,
        partitions_without_primary,
        under_replicated_partitions,
    }
}

pub(super) async fn read_cluster_health(
    coordinator: &EtcdCoordinator,
) -> ClusterResult<ClusterHealth> {
    let served = served_indexes(coordinator).await?;
    let registered: HashSet<String> = coordinator
        .list_nodes()
        .await?
        .into_iter()
        .map(|node| node.node_id)
        .collect();
    let indexes: Vec<IndexHealth> = served
        .into_iter()
        .map(|index| health_of(index, &registered))
        .collect();
    let status = indexes
        .iter()
        .map(|index| index.status)
        .max()
        .unwrap_or(HealthStatus::Green);
    Ok(ClusterHealth { status, indexes })
}
