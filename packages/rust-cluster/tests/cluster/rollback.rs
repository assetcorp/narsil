use std::time::Duration;

use narsil_cluster::transport::NodeTransport;

mod data_node;
mod ledger;
mod support;

use data_node::{Scratch, cluster_coordinator};
use ledger::{
    Forwarded, Ledger, document_ids, first_difference, forward_insert, placement, start_cluster,
};

const INSYNC_REMOVAL_FAILED: &str = "REPLICATION_INSYNC_REMOVAL_FAILED";
const ROLLED_BACK: &str = "rolled-back-entry";
const REPLICA_AWAY_FOR: Duration = Duration::from_millis(1_500);

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_primary_rolls_back_a_write_that_it_could_not_replicate_once_its_in_sync_copy_returns()
 {
    let Some(coordinator) = cluster_coordinator().await else {
        return;
    };
    let controller_scratch = Scratch::new();
    let (controller, mut members, primary_at) =
        start_cluster(&coordinator, &controller_scratch).await;
    let replica_at = 1 - primary_at;
    let replica_id = members[replica_at].node_id;
    let mut ledger = Ledger::new();
    ledger
        .insert_all(members[primary_at].data(), &document_ids("settled", 3))
        .await;

    controller.stop().await;
    members[replica_at].stop().await;
    let primary_address = members[primary_at].data().address.clone();
    let forwarder = ledger::forwarder();
    let write = tokio::spawn(async move {
        let forwarded = forward_insert(&forwarder, &primary_address, ROLLED_BACK).await;
        forwarder.shutdown().await;
        forwarded
    });
    tokio::time::sleep(REPLICA_AWAY_FOR).await;
    members[replica_at].restart(&coordinator).await;
    let forwarded = write.await.expect("the write ends without a panic");

    let Forwarded::Refused(refused) = forwarded else {
        panic!("the primary should refuse a write that no in-sync copy took");
    };
    assert_eq!(
        refused.text("code"),
        INSYNC_REMOVAL_FAILED,
        "every in-sync copy dropped the write, so the primary answers the failure that stopped it: {refused:?}"
    );
    let placed = placement(&coordinator).await.expect("the ledger is placed");
    assert!(
        placed.lists_in_sync(replica_id),
        "{replica_id} stays in sync"
    );
    let absent = [ROLLED_BACK.to_string()];
    for member in &members {
        let difference = first_difference(member.data(), &ledger.written, &absent).await;
        assert!(
            difference.is_none(),
            "{} holds the acknowledged writes and none of the rolled-back one: {difference:?}",
            member.node_id
        );
    }

    ledger.forwarder.shutdown().await;
    for member in &mut members {
        member.stop().await;
    }
    coordinator.shutdown().await;
}
