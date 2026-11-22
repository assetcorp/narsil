use narsil_cluster::coordinator::etcd::EtcdCoordinator;

mod child_node;
mod data_node;
mod ledger;
mod rounds;
mod support;
mod typescript_node;

use child_node::{ChildNode, registered_address, serve_until_killed};
use data_node::{
    DataNode, Scratch, coordinator_at, create_cluster_index, etcd_endpoint, eventually,
    unique_key_prefix,
};
use ledger::{
    FIRST_DATA_NODE, LEDGER, LEDGER_UUID, SECOND_DATA_NODE, first_difference, placement,
    start_controller,
};
use rounds::write_rounds_across_a_kill;
use typescript_node::TypescriptNode;

const CHILD_TEST: &str = "a_rust_data_node_that_serves_a_mixed_ledger_until_its_process_is_killed";
const PARENT_HEARTBEAT_TTL_SECONDS: u64 = 30;
const TYPESCRIPT_HEARTBEAT_TTL_SECONDS: u64 = 15;
const TYPESCRIPT_DATA_NODE: &str = "ledger-typescript-data";
const ROUTER: &str = "ledger-router";

#[tokio::test(flavor = "multi_thread")]
#[ignore = "the mixed failover test starts this as a separate process and kills it"]
async fn a_rust_data_node_that_serves_a_mixed_ledger_until_its_process_is_killed() {
    serve_until_killed().await;
}

async fn led_by(coordinator: &EtcdCoordinator, node_id: &str, what: &str) {
    eventually(what, || async {
        placement(coordinator)
            .await
            .is_some_and(|placed| placed.is_led_by(node_id))
    })
    .await;
}

async fn admitted(coordinator: &EtcdCoordinator, node_id: &str) {
    eventually("the replica joins the in-sync set", || async {
        placement(coordinator)
            .await
            .is_some_and(|placed| placed.admits(node_id))
    })
    .await;
}

async fn registered(coordinator: &EtcdCoordinator, node_id: &str) {
    eventually("the primary's process registers its node", || async {
        registered_address(coordinator, node_id).await.is_some()
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_typescript_replica_takes_over_a_killed_rust_primary_with_every_acknowledged_write() {
    let Some(endpoint) = etcd_endpoint() else {
        return;
    };
    let key_prefix = unique_key_prefix();
    let coordinator = coordinator_at(
        endpoint.clone(),
        key_prefix.clone(),
        PARENT_HEARTBEAT_TTL_SECONDS,
    )
    .await;
    let controller_scratch = Scratch::new();
    let controller = start_controller(&coordinator, &controller_scratch).await;
    let primary_scratch = Scratch::new();
    let mut primary = ChildNode::spawn(
        CHILD_TEST,
        &endpoint,
        &key_prefix,
        FIRST_DATA_NODE,
        &primary_scratch,
    );
    registered(&coordinator, FIRST_DATA_NODE).await;
    create_cluster_index(&coordinator, LEDGER, LEDGER_UUID, 1, 1).await;
    led_by(
        &coordinator,
        FIRST_DATA_NODE,
        "the Rust node leads the ledger",
    )
    .await;
    let mut replica =
        TypescriptNode::start(&endpoint, &key_prefix, TYPESCRIPT_DATA_NODE, "data").await;
    admitted(&coordinator, TYPESCRIPT_DATA_NODE).await;
    let router_scratch = Scratch::new();
    let router = DataNode::start_with_roles(
        &coordinator,
        ROUTER,
        router_scratch.path(),
        &["coordinator"],
    )
    .await;

    let outcomes = write_rounds_across_a_kill(&router, async { primary.kill() }).await;
    led_by(
        &coordinator,
        TYPESCRIPT_DATA_NODE,
        "the controller promotes the TypeScript replica",
    )
    .await;
    let must_be_held = outcomes.must_be_held();
    for (document_id, title) in &must_be_held {
        let held = replica.title(LEDGER, document_id).await;
        assert_eq!(
            held.as_deref(),
            Some(title.as_str()),
            "the promoted TypeScript copy holds {document_id}, one of {} acknowledged writes",
            outcomes.acknowledged()
        );
    }
    outcomes.assert_one_clean_round_after_the_kill();

    router.stop().await;
    replica.shutdown().await;
    controller.stop().await;
    coordinator.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_replica_takes_over_a_killed_typescript_primary_with_every_acknowledged_write() {
    let Some(endpoint) = etcd_endpoint() else {
        return;
    };
    let key_prefix = unique_key_prefix();
    let coordinator = coordinator_at(
        endpoint.clone(),
        key_prefix.clone(),
        PARENT_HEARTBEAT_TTL_SECONDS,
    )
    .await;
    let controller_scratch = Scratch::new();
    let controller = start_controller(&coordinator, &controller_scratch).await;
    let primary = TypescriptNode::start_with_heartbeat_ttl(
        &endpoint,
        &key_prefix,
        TYPESCRIPT_DATA_NODE,
        "data",
        Some(TYPESCRIPT_HEARTBEAT_TTL_SECONDS),
    )
    .await;
    registered(&coordinator, TYPESCRIPT_DATA_NODE).await;
    create_cluster_index(&coordinator, LEDGER, LEDGER_UUID, 1, 1).await;
    led_by(
        &coordinator,
        TYPESCRIPT_DATA_NODE,
        "the TypeScript node leads the ledger",
    )
    .await;
    let replica_scratch = Scratch::new();
    let replica = DataNode::start(&coordinator, SECOND_DATA_NODE, replica_scratch.path()).await;
    admitted(&coordinator, SECOND_DATA_NODE).await;
    let router_scratch = Scratch::new();
    let router = DataNode::start_with_roles(
        &coordinator,
        ROUTER,
        router_scratch.path(),
        &["coordinator"],
    )
    .await;

    let outcomes = write_rounds_across_a_kill(&router, primary.kill()).await;
    led_by(
        &coordinator,
        SECOND_DATA_NODE,
        "the controller promotes the Rust replica",
    )
    .await;
    let must_be_held = outcomes.must_be_held();
    let difference = first_difference(&replica, &must_be_held, &[]).await;
    assert!(
        difference.is_none(),
        "the promoted Rust copy holds all {} acknowledged writes: {difference:?}",
        outcomes.acknowledged()
    );
    outcomes.assert_one_clean_round_after_the_kill();

    router.stop().await;
    replica.stop().await;
    controller.stop().await;
    coordinator.shutdown().await;
}
