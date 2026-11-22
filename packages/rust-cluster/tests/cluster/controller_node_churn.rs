use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use narsil::Value;
use narsil_cluster::SPEC_VERSION;
use narsil_cluster::coordinator::AllocationTable;
use narsil_cluster::coordinator::etcd::EtcdCoordinator;
use narsil_cluster::transport::NodeTransport;

use crate::controller_lost_copy::{active_assignment, registration, start_controller};
use crate::data_node::{cluster_coordinator, create_cluster_index};

const ORDERS: &str = "orders";
const ORDERS_UUID: &str = "uuid-of-the-orders";
const SERVING_NODE: &str = "data-a";
const NEW_DATA_NODE: &str = "data-b";
const CHURN_INTERVAL: Duration = Duration::from_millis(200);
const CONTROLLER_SETTLES_FOR: Duration = Duration::from_secs(1);
const PLACED_WITHIN: Duration = Duration::from_secs(4);
const POLL: Duration = Duration::from_millis(25);

async fn store_orders_served_without_a_replica(coordinator: &EtcdCoordinator) {
    create_cluster_index(coordinator, ORDERS, ORDERS_UUID, 1, 1).await;
    let table = AllocationTable {
        index_name: ORDERS.to_string(),
        version: 1.0,
        replication_factor: 1.0,
        assignments: vec![(0.0, active_assignment(SERVING_NODE))],
        generation: None,
        index_uuid: Some(ORDERS_UUID.to_string()),
    };
    coordinator
        .put_allocation(ORDERS, &table)
        .await
        .expect("etcd takes the table");
}

async fn replica_on_new_node(coordinator: &EtcdCoordinator) -> bool {
    let table = coordinator
        .allocation(ORDERS)
        .await
        .expect("etcd answers for the table");
    let Some(table) = table else {
        return false;
    };
    let [(_, assignment)] = table.assignments.as_slice() else {
        return false;
    };
    assignment
        .get("replicas")
        .and_then(Value::as_array)
        .is_some_and(|replicas| {
            replicas
                .iter()
                .any(|replica| replica.as_str() == Some(NEW_DATA_NODE))
        })
}

async fn register_gateways_until_stopped(
    coordinator: Arc<EtcdCoordinator>,
    churning: Arc<AtomicBool>,
) {
    let mut joined = 0;
    while churning.load(Ordering::SeqCst) {
        joined += 1;
        coordinator
            .register_node(&registration(
                &format!("gateway-{joined}"),
                &["coordinator"],
                SPEC_VERSION,
            ))
            .await
            .expect("etcd takes the registration");
        tokio::time::sleep(CHURN_INTERVAL).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_controller_places_a_replica_while_coordinator_nodes_join_every_200_ms() {
    let Some(coordinator) = cluster_coordinator().await else {
        return;
    };
    store_orders_served_without_a_replica(&coordinator).await;
    coordinator
        .register_node(&registration(SERVING_NODE, &["data"], SPEC_VERSION))
        .await
        .expect("etcd takes the registration");
    let controller = start_controller(&coordinator).await;
    tokio::time::sleep(CONTROLLER_SETTLES_FOR).await;
    assert!(!replica_on_new_node(&coordinator).await);

    let churning = Arc::new(AtomicBool::new(true));
    let churn = tokio::spawn(register_gateways_until_stopped(
        Arc::clone(&coordinator),
        Arc::clone(&churning),
    ));
    tokio::time::sleep(CHURN_INTERVAL / 2).await;
    coordinator
        .register_node(&registration(NEW_DATA_NODE, &["data"], SPEC_VERSION))
        .await
        .expect("etcd takes the registration");

    let deadline = Instant::now() + PLACED_WITHIN;
    let mut placed = false;
    while Instant::now() < deadline {
        if replica_on_new_node(&coordinator).await {
            placed = true;
            break;
        }
        tokio::time::sleep(POLL).await;
    }
    churning.store(false, Ordering::SeqCst);
    churn.await.expect("the registrations finish");
    assert!(
        placed,
        "the controller placed no replica on {NEW_DATA_NODE} while nodes kept joining"
    );

    controller.node.shutdown().await;
    controller.transport.shutdown().await;
    coordinator.shutdown().await;
}
