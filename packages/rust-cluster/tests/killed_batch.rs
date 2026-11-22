use std::collections::BTreeMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use narsil::{Map, Value};
use narsil_cluster::error::ClusterError;
use narsil_cluster::node::WriteBatchResult;

mod child_node;
mod data_node;
mod ledger;
mod support;

use child_node::{ChildNode, registered_address, serve_until_killed};
use data_node::{
    DataNode, Scratch, coordinator_at, create_cluster_index, etcd_endpoint, eventually,
    unique_key_prefix,
};
use ledger::{
    FIRST_DATA_NODE, LEDGER, LEDGER_UUID, SECOND_DATA_NODE, first_difference, placement,
    start_controller, title_of,
};

const CHILD_TEST: &str = "a_data_node_that_serves_its_batches_until_its_process_is_killed";
const PARENT_HEARTBEAT_TTL_SECONDS: u64 = 30;
const BATCH_SIZE: usize = 200;
const ACKNOWLEDGED_BEFORE_THE_KILL: usize = 600;
const ROUTER: &str = "ledger-router";
const ANSWERS_THAT_LEAVE_THE_WRITE_UNSETTLED: [&str; 2] =
    ["DOC_ALREADY_EXISTS", "REPLICATION_OUTCOME_UNKNOWN"];

#[derive(Default)]
struct Outcomes {
    acknowledged: BTreeMap<String, String>,
    unsettled: Vec<(String, ClusterError)>,
    batches_after_the_kill: Vec<WriteBatchResult>,
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "the killed-batch test starts this as a separate process and kills it"]
async fn a_data_node_that_serves_its_batches_until_its_process_is_killed() {
    serve_until_killed().await;
}

fn round_of(round: usize) -> Vec<Map> {
    (0..BATCH_SIZE)
        .map(|serial| {
            let document_id = format!("round-{round}-{serial}");
            [
                ("id", Value::from(document_id.as_str())),
                ("title", Value::from(title_of(&document_id))),
            ]
            .into_iter()
            .collect()
        })
        .collect()
}

fn record(outcomes: &Mutex<Outcomes>, result: &WriteBatchResult) {
    let mut outcomes = outcomes.lock().expect("no writer panicked");
    for document_id in &result.succeeded {
        outcomes
            .acknowledged
            .insert(document_id.clone(), title_of(document_id));
    }
    for failure in &result.failed {
        outcomes
            .unsettled
            .push((failure.document_id.clone(), failure.error.clone()));
    }
}

async fn write_rounds_past_the_kill(
    router: &DataNode,
    outcomes: &Mutex<Outcomes>,
    killed: &AtomicBool,
) {
    for round in 0.. {
        let started_after_the_kill = killed.load(Ordering::Acquire);
        let result = router
            .node
            .insert_batch(LEDGER, round_of(round))
            .await
            .expect("the router routes every round");
        record(outcomes, &result);
        if started_after_the_kill {
            outcomes
                .lock()
                .expect("no writer panicked")
                .batches_after_the_kill
                .push(result);
            return;
        }
    }
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

    let outcomes = Mutex::new(Outcomes::default());
    let killed = AtomicBool::new(false);
    let kill_mid_batch = async {
        eventually("the primary acknowledges the first rounds", || async {
            outcomes
                .lock()
                .expect("no writer panicked")
                .acknowledged
                .len()
                >= ACKNOWLEDGED_BEFORE_THE_KILL
        })
        .await;
        killed.store(true, Ordering::Release);
        primary.kill();
    };
    tokio::join!(
        write_rounds_past_the_kill(&router, &outcomes, &killed),
        kill_mid_batch
    );
    let outcomes = outcomes.into_inner().expect("no writer panicked");

    eventually("the controller promotes the in-sync replica", || async {
        placement(&coordinator)
            .await
            .is_some_and(|placed| placed.is_led_by(SECOND_DATA_NODE))
    })
    .await;
    let difference = first_difference(&replica, &outcomes.acknowledged, &[]).await;
    assert!(
        difference.is_none(),
        "the promoted replica holds all {} acknowledged writes: {difference:?}",
        outcomes.acknowledged.len()
    );
    for (document_id, error) in &outcomes.unsettled {
        assert!(
            ANSWERS_THAT_LEAVE_THE_WRITE_UNSETTLED.contains(&error.code()),
            "{document_id} failed with {error:?}"
        );
        if error.code() == "DOC_ALREADY_EXISTS" {
            let held: BTreeMap<String, String> =
                [(document_id.clone(), title_of(document_id))].into();
            let difference = first_difference(&replica, &held, &[]).await;
            assert!(difference.is_none(), "{difference:?}");
        }
    }
    let after_the_kill = &outcomes.batches_after_the_kill;
    assert_eq!(after_the_kill.len(), 1);
    assert!(
        after_the_kill[0].failed.is_empty(),
        "a round sent after the kill reaches the promoted replica: {:?}",
        after_the_kill[0].failed.first()
    );
    assert_eq!(after_the_kill[0].succeeded.len(), BATCH_SIZE);

    router.stop().await;
    replica.stop().await;
    controller.stop().await;
    coordinator.shutdown().await;
}
