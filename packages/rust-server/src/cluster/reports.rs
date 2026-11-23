use narsil::{Value, write_plain_json};
use narsil_cluster::node::{
    ClusterHealth, ClusterMetrics, ClusterNode, CoordinatorRequestFigure, IndexHealth,
};

use super::{node_report, served_error};
use crate::constants::PROMETHEUS_TEXT_CONTENT_TYPE;
use crate::errors::{Outcome, ServerError};
use crate::handlers::common::object;
use crate::http::respond::{HttpResponse, full_body, json, with_body};
use crate::http::routes::Route;

const REPLICATION_LAG_HELP: &str = "Entries that the replica has yet to acknowledge, as the primary's last sequence number minus the replica's.";
const COMMIT_POINT_HELP: &str =
    "The highest sequence number that the leader of the partition has acknowledged to a client.";
const COMMIT_POINT_FLOOR_HELP: &str = "The floor on the commit point that the allocation table stores, raised when the controller admits a replica.";
const IN_SYNC_REPLICAS_HELP: &str =
    "The replicas besides the primary that are in the in-sync set of the partition.";
const WAITING_FOR_MEMORY_HELP: &str = "A vector field whose rebuild waits for the node to have memory for a second graph, reported as 1.";
const COORDINATOR_REQUEST_HELP: &str =
    "How long the calls from this node to the cluster coordinator took.";

async fn topology(node: &ClusterNode) -> Outcome<HttpResponse> {
    let readiness = node.readiness().await;
    let nodes = node.list_nodes().await.map_err(served_error)?;
    let controller = node.controller_node_id().await.map_err(served_error)?;
    let listed = nodes
        .into_iter()
        .map(|registration| {
            let memory = registration
                .extra
                .get("memory")
                .cloned()
                .unwrap_or(Value::Null);
            object(vec![
                ("nodeId", Value::String(registration.node_id)),
                ("address", Value::String(registration.address)),
                (
                    "roles",
                    Value::Array(registration.roles.into_iter().map(Value::String).collect()),
                ),
                ("memory", memory),
            ])
        })
        .collect();
    let answer = object(vec![
        ("node", node_report(node, readiness)),
        (
            "controllerNodeId",
            controller.map_or(Value::Null, Value::String),
        ),
        ("nodes", Value::Array(listed)),
    ]);
    Ok(json(200, &answer))
}

fn index_health(index: IndexHealth) -> Value {
    object(vec![
        ("indexName", Value::String(index.index_name)),
        ("status", Value::from(index.status.as_str())),
        ("partitionCount", Value::Number(index.partition_count)),
        ("replicationFactor", Value::Number(index.replication_factor)),
        (
            "partitionsWithoutPrimary",
            Value::from(index.partitions_without_primary),
        ),
        (
            "underReplicatedPartitions",
            Value::from(index.under_replicated_partitions),
        ),
    ])
}

fn health_json(health: ClusterHealth) -> Value {
    object(vec![
        ("status", Value::from(health.status.as_str())),
        (
            "indexes",
            Value::Array(health.indexes.into_iter().map(index_health).collect()),
        ),
    ])
}

fn number(value: f64) -> String {
    write_plain_json(&Value::Number(value))
}

fn label_value(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

fn labels(pairs: &[(&str, &str)]) -> String {
    let joined: Vec<String> = pairs
        .iter()
        .map(|(name, value)| format!("{name}=\"{}\"", label_value(value)))
        .collect();
    format!("{{{}}}", joined.join(","))
}

fn family(lines: &mut Vec<String>, name: &str, kind: &str, help: &str, samples: Vec<String>) {
    lines.push(format!("# HELP {name} {help}"));
    lines.push(format!("# TYPE {name} {kind}"));
    lines.extend(samples);
}

fn histogram_samples(figure: &CoordinatorRequestFigure) -> Vec<String> {
    let name = "narsil_coordinator_request_seconds";
    let operation = ("operation", figure.operation.as_str());
    let mut samples: Vec<String> = figure
        .bucket_bounds_seconds
        .iter()
        .enumerate()
        .map(|(position, bound)| {
            let bound = number(*bound);
            let count = figure.bucket_counts.get(position).copied().unwrap_or(0);
            format!(
                "{name}_bucket{} {count}",
                labels(&[operation, ("le", &bound)])
            )
        })
        .collect();
    let count = figure.count;
    samples.push(format!(
        "{name}_bucket{} {count}",
        labels(&[operation, ("le", "+Inf")])
    ));
    samples.push(format!(
        "{name}_sum{} {}",
        labels(&[operation]),
        number(figure.sum_seconds)
    ));
    samples.push(format!("{name}_count{} {count}", labels(&[operation])));
    samples
}

fn prometheus_text(metrics: &ClusterMetrics) -> String {
    let mut lines = Vec::new();
    let lag = metrics.replication_lag.iter().map(|figure| {
        let partition = figure.partition_id.to_string();
        let pairs = [
            ("index", figure.index_name.as_str()),
            ("partition", partition.as_str()),
            ("replica", figure.replica.as_str()),
        ];
        format!("narsil_replication_lag{} {}", labels(&pairs), figure.lag)
    });
    family(
        &mut lines,
        "narsil_replication_lag",
        "gauge",
        REPLICATION_LAG_HELP,
        lag.collect(),
    );
    let commit_points = metrics.commit_points.iter().map(|figure| {
        let partition = figure.partition_id.to_string();
        let pairs = [
            ("index", figure.index_name.as_str()),
            ("partition", partition.as_str()),
        ];
        format!(
            "narsil_commit_point{} {}",
            labels(&pairs),
            figure.commit_point
        )
    });
    family(
        &mut lines,
        "narsil_commit_point",
        "gauge",
        COMMIT_POINT_HELP,
        commit_points.collect(),
    );
    let floors = metrics.partitions.iter().map(|figure| {
        let partition = figure.partition_id.to_string();
        let pairs = [
            ("index", figure.index_name.as_str()),
            ("partition", partition.as_str()),
        ];
        let floor = number(figure.commit_point_floor);
        format!("narsil_commit_point_floor{} {floor}", labels(&pairs))
    });
    family(
        &mut lines,
        "narsil_commit_point_floor",
        "gauge",
        COMMIT_POINT_FLOOR_HELP,
        floors.collect(),
    );
    let in_sync = metrics.partitions.iter().map(|figure| {
        let partition = figure.partition_id.to_string();
        let pairs = [
            ("index", figure.index_name.as_str()),
            ("partition", partition.as_str()),
        ];
        format!(
            "narsil_in_sync_replicas{} {}",
            labels(&pairs),
            figure.in_sync_replicas
        )
    });
    family(
        &mut lines,
        "narsil_in_sync_replicas",
        "gauge",
        IN_SYNC_REPLICAS_HELP,
        in_sync.collect(),
    );
    family(
        &mut lines,
        "narsil_vector_rebuild_waiting_for_memory",
        "gauge",
        WAITING_FOR_MEMORY_HELP,
        Vec::new(),
    );
    let requests = metrics
        .coordinator_requests
        .iter()
        .flat_map(histogram_samples);
    family(
        &mut lines,
        "narsil_coordinator_request_seconds",
        "histogram",
        COORDINATOR_REQUEST_HELP,
        requests.collect(),
    );
    format!("{}\n", lines.join("\n"))
}

async fn metrics(node: &ClusterNode) -> Outcome<HttpResponse> {
    let metrics = node.metrics().await.map_err(served_error)?;
    let text = prometheus_text(&metrics);
    Ok(with_body(
        200,
        PROMETHEUS_TEXT_CONTENT_TYPE,
        full_body(text),
    ))
}

pub(super) async fn handle(node: &ClusterNode, route: Route) -> Outcome<HttpResponse> {
    match route {
        Route::ClusterTopology => topology(node).await,
        Route::ClusterHealth => {
            let health = node.health().await.map_err(served_error)?;
            Ok(json(200, &health_json(health)))
        }
        Route::Metrics => metrics(node).await,
        _ => Err(ServerError::internal()),
    }
}
