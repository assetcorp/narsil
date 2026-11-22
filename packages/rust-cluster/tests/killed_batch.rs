mod child_node;
mod data_node;
mod ledger;
mod rounds;
mod support;

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

const CHILD_TEST: &str = "a_data_node_that_serves_its_batches_until_its_process_is_killed";
const PARENT_HEARTBEAT_TTL_SECONDS: u64 = 30;
const ROUTER: &str = "ledger-router";

#[tokio::test(flavor = "multi_thread")]
#[ignore = "the killed-batch test starts this as a separate process and kills it"]
async fn a_data_node_that_serves_its_batches_until_its_process_is_killed() {
    serve_until_killed().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn every_batched_write_that_the_router_acknowledged_survives_a_killed_rust_primary() {
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
    eventually("the primary's process registers its node", || async {
        registered_address(&coordinator, FIRST_DATA_NODE)
            .await
            .is_some()
    })
    .await;
    create_cluster_index(&coordinator, LEDGER, LEDGER_UUID, 1, 1).await;
    eventually("the first data node leads the ledger", || async {
        placement(&coordinator)
            .await
            .is_some_and(|placed| placed.is_led_by(FIRST_DATA_NODE))
    })
    .await;
    let replica_scratch = Scratch::new();
    let replica = DataNode::start(&coordinator, SECOND_DATA_NODE, replica_scratch.path()).await;
    eventually("the replica joins the in-sync set", || async {
        placement(&coordinator)
            .await
            .is_some_and(|placed| placed.admits(SECOND_DATA_NODE))
    })
    .await;
    let router_scratch = Scratch::new();
    let router = DataNode::start_with_roles(
        &coordinator,
        ROUTER,
        router_scratch.path(),
        &["coordinator"],
    )
    .await;

    let outcomes = write_rounds_across_a_kill(&router, async { primary.kill() }).await;
    eventually("the controller promotes the in-sync replica", || async {
        placement(&coordinator)
            .await
            .is_some_and(|placed| placed.is_led_by(SECOND_DATA_NODE))
    })
    .await;
    let must_be_held = outcomes.must_be_held();
    let difference = first_difference(&replica, &must_be_held, &[]).await;
    assert!(
        difference.is_none(),
        "the promoted replica holds all {} acknowledged writes: {difference:?}",
        outcomes.acknowledged()
    );
    outcomes.assert_one_clean_round_after_the_kill();

    router.stop().await;
    replica.stop().await;
    controller.stop().await;
    coordinator.shutdown().await;
}
