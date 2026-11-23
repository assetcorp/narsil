use narsil::Value;
use narsil_cluster::coordinator::AllocationTable;
use narsil_cluster::coordinator::etcd::EtcdCoordinator;

use crate::data_node::{
    DataNode, Scratch, coordinator_at, etcd_endpoint, eventually, unique_key_prefix,
};
use crate::typescript_node::{TypescriptNode, fields};

const SPECIMENS: &str = "specimens";
const PARTITION_COUNT: u64 = 2;
const ROUTER: &str = "specimens-router";
const CABINET_A: &str = "specimens-cabinet-a";
const CABINET_B: &str = "specimens-cabinet-b";
const HEARTBEAT_TTL_SECONDS: u64 = 30;
const SPECIMEN_COUNT: usize = 12;
const CONTROLLER: &str = "specimens-controller";

fn node_ids(assignment: &narsil::Map, field: &str) -> Vec<String> {
    assignment
        .get(field)
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn settled_at(
    table: Option<&AllocationTable>,
    replication_factor: f64,
    replica_count: usize,
) -> bool {
    let Some(table) = table else {
        return false;
    };
    if table.assignments.len() != PARTITION_COUNT as usize
        || table.replication_factor != replication_factor
    {
        return false;
    }
    table.assignments.iter().all(|(_, assignment)| {
        let replicas = node_ids(assignment, "replicas");
        let in_sync = node_ids(assignment, "inSyncSet");
        assignment.get("state").and_then(Value::as_str) == Some("ACTIVE")
            && assignment.get("primary").and_then(Value::as_str).is_some()
            && replicas.len() == replica_count
            && replicas.iter().all(|replica| in_sync.contains(replica))
    })
}

async fn wait_for_factor(
    coordinator: &EtcdCoordinator,
    replication_factor: f64,
    replica_count: usize,
) {
    eventually("the index settles at the replication factor", || async {
        let table = coordinator
            .allocation(SPECIMENS)
            .await
            .expect("etcd answers for the table");
        settled_at(table.as_ref(), replication_factor, replica_count)
    })
    .await;
}

fn specimen_title(position: usize) -> String {
    format!("Pressed fern specimen {position}")
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_controller_adds_replicas_that_hold_every_document_so_the_index_survives_losing_the_only_copy()
 {
    let Some(endpoint) = etcd_endpoint() else {
        return;
    };
    let key_prefix = unique_key_prefix();
    let coordinator =
        coordinator_at(endpoint.clone(), key_prefix.clone(), HEARTBEAT_TTL_SECONDS).await;
    let controller_scratch = Scratch::new();
    let controller = DataNode::start_configured(
        &coordinator,
        CONTROLLER,
        controller_scratch.path(),
        &["controller"],
        |settings| settings.controller.node_left_delay_ms = 0,
    )
    .await;
    let mut router = TypescriptNode::start(&endpoint, &key_prefix, ROUTER, "coordinator").await;
    let cabinet_a = TypescriptNode::start(&endpoint, &key_prefix, CABINET_A, "data").await;
    let cabinet_b = TypescriptNode::start(&endpoint, &key_prefix, CABINET_B, "data").await;
    router.create_index(SPECIMENS, PARTITION_COUNT, 0).await;
    wait_for_factor(&coordinator, 0.0, 0).await;
    for position in 0..SPECIMEN_COUNT {
        let answer = router
            .insert(
                SPECIMENS,
                &format!("specimen-{position}"),
                &specimen_title(position),
            )
            .await;
        assert_eq!(answer.code(), None);
    }

    let raised = router
        .call(
            "setReplicationFactor",
            fields([
                ("indexName", Value::from(SPECIMENS)),
                ("replicationFactor", Value::from(1.0)),
            ]),
        )
        .await;
    assert_eq!(raised.code(), None);
    wait_for_factor(&coordinator, 1.0, 1).await;

    for refused in [-1.0, 256.0, 1.5] {
        let answer = router
            .call(
                "setReplicationFactor",
                fields([
                    ("indexName", Value::from(SPECIMENS)),
                    ("replicationFactor", Value::from(refused)),
                ]),
            )
            .await;
        assert_eq!(answer.code(), Some("CONFIG_INVALID"));
    }

    cabinet_a.shutdown().await;
    wait_for_factor(&coordinator, 1.0, 0).await;
    for position in 0..SPECIMEN_COUNT {
        let held = router
            .title(SPECIMENS, &format!("specimen-{position}"))
            .await;
        assert_eq!(held, Some(specimen_title(position)));
    }

    router.shutdown().await;
    cabinet_b.shutdown().await;
    controller.stop().await;
    coordinator.shutdown().await;
}
