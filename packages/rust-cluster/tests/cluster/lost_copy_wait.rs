use std::sync::Arc;
use std::time::{Duration, Instant};

use narsil::Value;
use narsil_cluster::transport::NodeTransport;

use crate::child_node::registered_address;
use crate::data_node::{DataNode, Scratch, cluster_coordinator, eventually};
use crate::ledger::{
    Ledger, document_ids, first_difference, placement, start_cluster, start_controller,
};

const COPY_MISSING: &str = "NODE_COPY_MISSING";
const WAIT_WITHOUT_A_CONTROLLER: Duration = Duration::from_secs(4);
const CHECK_INTERVAL: Duration = Duration::from_millis(100);

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_node_that_restarts_with_an_empty_directory_waits_until_the_controller_fails_its_copy_over()
 {
    let Some(coordinator) = cluster_coordinator().await else {
        return;
    };
    let controller_scratch = Scratch::new();
    let (controller, mut members, primary_at) =
        start_cluster(&coordinator, &controller_scratch).await;
    let replica_at = 1 - primary_at;
    let (lost_id, replica_id) = (members[primary_at].node_id, members[replica_at].node_id);
    let mut ledger = Ledger::new();
    ledger
        .insert_all(
            members[primary_at].data(),
            &document_ids("before-the-loss", 12),
        )
        .await;
    let first_term = placement(&coordinator)
        .await
        .expect("the ledger is placed")
        .primary_term;

    controller.stop().await;
    members[primary_at].stop().await;
    let empty = Scratch::new();
    let restarting = {
        let coordinator = Arc::clone(&coordinator);
        let directory = empty.path().to_path_buf();
        tokio::spawn(async move { DataNode::start(&coordinator, lost_id, &directory).await })
    };
    let watch_until = Instant::now() + WAIT_WITHOUT_A_CONTROLLER;
    while Instant::now() < watch_until {
        assert!(
            registered_address(&coordinator, lost_id).await.is_none(),
            "{lost_id} registers without the copy that the table assigns to it"
        );
        let placed = placement(&coordinator).await.expect("the ledger is placed");
        assert!(
            placed.is_led_by(lost_id),
            "only a controller moves the ledger"
        );
        assert_eq!(placed.primary_term, first_term);
        assert!(
            !restarting.is_finished(),
            "{lost_id} joins without its copy"
        );
        tokio::time::sleep(CHECK_INTERVAL).await;
    }

    let second_controller_scratch = Scratch::new();
    let controller = start_controller(&coordinator, &second_controller_scratch).await;
    eventually(
        "the controller promotes the replica that kept the copy",
        || async {
            placement(&coordinator).await.is_some_and(|placed| {
                placed.is_led_by(replica_id) && placed.primary_term > first_term
            })
        },
    )
    .await;
    let returned = restarting
        .await
        .expect("the restarted node joins without a panic");
    let reported = returned
        .reported
        .lock()
        .expect("no reporter panicked")
        .clone();
    assert!(
        reported.iter().any(|error| {
            error.code() == COPY_MISSING
                && error.details().get("partitionId") == Some(&Value::from(0))
        }),
        "the restarted node reports the copy that it lacks: {reported:?}"
    );
    eventually("the restarted node syncs back as a replica", || async {
        placement(&coordinator)
            .await
            .is_some_and(|placed| placed.admits(lost_id))
    })
    .await;
    let promoted = members[replica_at].data();
    let difference = first_difference(promoted, &ledger.written, &[]).await;
    assert!(
        difference.is_none(),
        "the promoted replica holds every acknowledged write: {difference:?}"
    );
    ledger
        .insert_until_accepted(promoted, "after-the-loss")
        .await;
    eventually(
        "the restarted node holds every acknowledged write",
        || async {
            first_difference(&returned, &ledger.written, &[])
                .await
                .is_none()
        },
    )
    .await;

    ledger.forwarder.shutdown().await;
    returned.stop().await;
    for member in &mut members {
        member.stop().await;
    }
    controller.stop().await;
    coordinator.shutdown().await;
}
