use super::tables::{in_sync_replicas_of, served_indexes};
use super::types::{
    ClusterMetrics, CommitPointFigure, PartitionReplicationFigure, ReplicaLagFigure,
};
use crate::allocator::Assignment;
use crate::coordinator::etcd::EtcdCoordinator;
use crate::data::DataRole;
use crate::data::writes::LedPartitionFigures;
use crate::error::ClusterResult;
use crate::query::selection::partition_id_of;

struct LedPartition<'a> {
    index_name: &'a str,
    partition_id: u32,
    assignment: &'a Assignment,
    figures: &'a LedPartitionFigures,
}

fn lag_of(node_id: &str, led: &LedPartition<'_>) -> Vec<ReplicaLagFigure> {
    led.assignment
        .replicas
        .iter()
        .filter(|replica| replica.as_str() != node_id)
        .map(|replica| {
            let acknowledged = led.figures.acknowledged.get(replica).copied().unwrap_or(0);
            let floor = if led.assignment.in_sync_set.contains(replica) {
                led.figures.commit_point
            } else {
                0
            };
            ReplicaLagFigure {
                index_name: led.index_name.to_string(),
                partition_id: led.partition_id,
                replica: replica.clone(),
                lag: led.figures.log_end.saturating_sub(acknowledged.max(floor)),
            }
        })
        .collect()
}

pub(super) async fn read_cluster_metrics(
    node_id: &str,
    coordinator: &EtcdCoordinator,
    data: Option<&DataRole>,
) -> ClusterResult<ClusterMetrics> {
    let mut metrics = ClusterMetrics {
        replication_lag: Vec::new(),
        commit_points: Vec::new(),
        partitions: Vec::new(),
        coordinator_requests: Vec::new(),
    };
    for index in served_indexes(coordinator).await? {
        let Some(table) = &index.table else {
            continue;
        };
        let mut ordered: Vec<(f64, &Assignment)> = table.assignments.iter().collect();
        ordered.sort_by(|left, right| left.0.total_cmp(&right.0));
        for (raw_partition_id, assignment) in ordered {
            let partition_id = partition_id_of(raw_partition_id);
            metrics.partitions.push(PartitionReplicationFigure {
                index_name: index.index_name.clone(),
                partition_id,
                commit_point_floor: assignment.commit_point,
                in_sync_replicas: in_sync_replicas_of(assignment).count() as u64,
            });
            if !assignment.is_primary(node_id) {
                continue;
            }
            let Some(data) = data else {
                continue;
            };
            let Some(figures) = data
                .led_partition_figures(&index.serving_name, partition_id)
                .await
            else {
                continue;
            };
            metrics.commit_points.push(CommitPointFigure {
                index_name: index.index_name.clone(),
                partition_id,
                commit_point: figures.commit_point,
            });
            let led = LedPartition {
                index_name: &index.index_name,
                partition_id,
                assignment,
                figures: &figures,
            };
            metrics.replication_lag.extend(lag_of(node_id, &led));
        }
    }
    metrics.coordinator_requests = coordinator.request_figures();
    Ok(metrics)
}
