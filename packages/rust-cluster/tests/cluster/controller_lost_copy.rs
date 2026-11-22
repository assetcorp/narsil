use std::sync::{Arc, Mutex};
use std::time::Duration;

use narsil::{Map, Value};
use narsil_cluster::SPEC_VERSION;
use narsil_cluster::coordinator::etcd::EtcdCoordinator;
use narsil_cluster::coordinator::{AllocationTable, NodeCapacity, NodeRegistration};
use narsil_cluster::error::ClusterError;
use narsil_cluster::node::{ClusterNode, ClusterNodeConfig};
use narsil_cluster::transport::NodeTransport;
use narsil_cluster::transport::tcp::{TcpTransport, TcpTransportConfig};

use crate::data_node::{cluster_coordinator, create_cluster_index, eventually};

const LEDGER: &str = "ledger";
const LEDGER_UUID: &str = "uuid-of-the-ledger";
const LOST_PRIMARY: &str = "data-lost";
const CONTROLLER: &str = "controller-only";
const NEWER_MAJOR_VERSION: &str = "2.0";
const STANDBY_RETRY_MS: u64 = 100;
const NOTHING_CHANGES_FOR: Duration = Duration::from_secs(4);

fn active_assignment(primary: &str) -> Map {
    let mut assignment = Map::new();
    assignment.insert("primary", Value::from(primary));
    assignment.insert("replicas", Value::Array(Vec::new()));
    assignment.insert("inSyncSet", Value::Array(Vec::new()));
    assignment.insert("commitPoint", Value::from(0.0));
    assignment.insert("state", Value::from("ACTIVE"));
    assignment.insert("primaryTerm", Value::from(1.0));
    assignment
}

async fn store_ledger_led_by_a_departed_node(coordinator: &EtcdCoordinator) {
    create_cluster_index(coordinator, LEDGER, LEDGER_UUID, 1, 0).await;
    let table = AllocationTable {
        index_name: LEDGER.to_string(),
        version: 1.0,
        replication_factor: 0.0,
        assignments: vec![(0.0, active_assignment(LOST_PRIMARY))],
        generation: None,
        index_uuid: Some(LEDGER_UUID.to_string()),
    };
    coordinator
        .put_allocation(LEDGER, &table)
        .await
        .expect("etcd takes the table");
}

fn registration(node_id: &str, roles: &[&str], version: &str) -> NodeRegistration {
    NodeRegistration {
        node_id: node_id.to_string(),
        address: "127.0.0.1:9".to_string(),
        roles: roles.iter().map(|role| role.to_string()).collect(),
        capacity: NodeCapacity::default(),
        started_at: "2026-11-22T00:00:00.000Z".to_string(),
        version: version.to_string(),
        extra: Map::new(),
    }
}

struct Controller {
    node: ClusterNode,
    transport: Arc<TcpTransport>,
    reported: Arc<Mutex<Vec<ClusterError>>>,
}

async fn start_controller(coordinator: &Arc<EtcdCoordinator>) -> Controller {
    let transport = Arc::new(
        TcpTransport::new(
            CONTROLLER,
            TcpTransportConfig {
                host: "127.0.0.1".to_string(),
                port: 0,
                ..TcpTransportConfig::default()
            },
        )
        .expect("the transport settings are valid"),
    );
    let mut settings = ClusterNodeConfig::new(
        Arc::clone(coordinator),
        transport.clone(),
        registration(CONTROLLER, &["controller"], SPEC_VERSION),
    );
    settings.controller.standby_retry_ms = STANDBY_RETRY_MS;
    settings.controller.node_left_delay_ms = 0;
    let reported = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&reported);
    settings.on_error = Some(Arc::new(move |error| {
        sink.lock()
            .expect("no reporter panicked")
            .push(error.clone());
    }));
    let node = ClusterNode::new(settings).expect("the controller's settings are valid");
    node.start().await.expect("the controller joins");
    Controller {
        node,
        transport,
        reported,
    }
}

async fn stored_ledger(coordinator: &EtcdCoordinator) -> Option<AllocationTable> {
    coordinator
        .allocation(LEDGER)
        .await
        .expect("etcd answers for the table")
}

fn lost_with_holder(table: &AllocationTable) -> bool {
    let [(_, assignment)] = table.assignments.as_slice() else {
        return false;
    };
    let holders = assignment.get("lastHolders").and_then(Value::as_array);
    assignment.get("state").and_then(Value::as_str) == Some("UNASSIGNED")
        && assignment.get("unassignedReason").and_then(Value::as_str) == Some("HOLDER_OFFLINE")
        && assignment.get("primary").is_none_or(Value::is_null)
        && holders.is_some_and(|holders| holders.iter().map(Value::as_str).eq([Some(LOST_PRIMARY)]))
}

async fn controller_fails_the_lost_primary_over(registered: Option<NodeRegistration>) {
    let Some(coordinator) = cluster_coordinator().await else {
        return;
    };
    store_ledger_led_by_a_departed_node(&coordinator).await;
    if let Some(registration) = &registered {
        coordinator
            .register_node(registration)
            .await
            .expect("etcd takes the registration");
    }
    let controller = start_controller(&coordinator).await;

    eventually(
        "the controller marks the lost partition unassigned because its holder is offline",
        || async {
            stored_ledger(&coordinator)
                .await
                .is_some_and(|table| lost_with_holder(&table))
        },
    )
    .await;
    let settled = stored_ledger(&coordinator)
        .await
        .expect("the table remains");
    tokio::time::sleep(NOTHING_CHANGES_FOR).await;
    assert_eq!(
        stored_ledger(&coordinator).await.map(|table| table.version),
        Some(settled.version),
        "the controller wrote the table again although nothing changed"
    );
    let codes: Vec<String> = controller
        .reported
        .lock()
        .expect("no reporter panicked")
        .iter()
        .map(|error| error.code().to_string())
        .collect();
    assert!(
        !codes.iter().any(|code| code == "ALLOCATION_NO_DATA_NODES"),
        "the controller reported {codes:?}"
    );

    controller.node.shutdown().await;
    controller.transport.shutdown().await;
    coordinator.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_controller_fails_over_a_lost_primary_while_no_data_node_is_registered() {
    controller_fails_the_lost_primary_over(None).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_controller_fails_over_a_lost_primary_while_only_a_newer_major_version_could_take_it() {
    controller_fails_the_lost_primary_over(Some(registration(
        "data-newer",
        &["data"],
        NEWER_MAJOR_VERSION,
    )))
    .await;
}
