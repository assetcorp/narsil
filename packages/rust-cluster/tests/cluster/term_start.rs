use narsil_cluster::transport::NodeTransport;

mod data_node;
mod ledger;
mod support;

use data_node::{Scratch, cluster_coordinator, create_cluster_index, eventually};
use ledger::{
    FIRST_DATA_NODE, LEDGER, LEDGER_UUID, Ledger, Member, SECOND_DATA_NODE, document_ids,
    first_difference, placement, start_controller,
};

const THIRD_DATA_NODE: &str = "ledger-data-c";
const REPLICATION_FACTOR: u64 = 2;

#[tokio::test(flavor = "multi_thread")]
async fn a_promoted_rust_primary_starts_its_term_with_the_other_in_sync_copy_and_replicates_to_it()
{
    let Some(coordinator) = cluster_coordinator().await else {
        return;
    };
    let controller_scratch = Scratch::new();
    let controller = start_controller(&coordinator, &controller_scratch).await;
    let mut members = [
        Member::start(&coordinator, FIRST_DATA_NODE).await,
        Member::start(&coordinator, SECOND_DATA_NODE).await,
        Member::start(&coordinator, THIRD_DATA_NODE).await,
    ];
    create_cluster_index(&coordinator, LEDGER, LEDGER_UUID, 1, REPLICATION_FACTOR).await;
    eventually("both replicas join the in-sync set", || async {
        placement(&coordinator).await.is_some_and(|placed| {
            placed.replicas.len() == 2
                && placed.replicas.iter().all(|replica| placed.admits(replica))
        })
    })
    .await;
    let before = placement(&coordinator).await.expect("the ledger is placed");
    let departed_at = members
        .iter()
        .position(|member| member.node_id == before.primary)
        .expect("a data node leads the ledger");
    let mut ledger = Ledger::new();
    ledger
        .insert_all(
            members[departed_at].data(),
            &document_ids("before-failover", 3),
        )
        .await;

    members[departed_at].stop().await;
    let departed_id = members[departed_at].node_id;
    eventually("the controller promotes an in-sync replica", || async {
        placement(&coordinator).await.is_some_and(|placed| {
            placed.primary != departed_id
                && placed.is_led_by(&placed.primary)
                && placed.primary_term > before.primary_term
        })
    })
    .await;
    let promoted = placement(&coordinator).await.expect("the ledger is placed");
    let successor_at = members
        .iter()
        .position(|member| member.node_id == promoted.primary)
        .expect("a data node leads the ledger");
    let follower_at = (0..members.len())
        .find(|at| *at != departed_at && *at != successor_at)
        .expect("a third data node remains");
    let follower_id = members[follower_at].node_id;
    assert!(
        promoted.lists_in_sync(follower_id),
        "{follower_id} answers the new term's start and stays in sync"
    );

    ledger
        .insert_until_accepted(members[successor_at].data(), "after-failover-0")
        .await;
    ledger
        .insert_all(
            members[successor_at].data(),
            &document_ids("after-failover-more", 3),
        )
        .await;
    let settled = placement(&coordinator).await.expect("the ledger is placed");
    assert!(
        settled.lists_in_sync(follower_id),
        "{follower_id} takes the new term's entries and stays in sync"
    );
    for at in [successor_at, follower_at] {
        let difference = first_difference(members[at].data(), &ledger.written, &[]).await;
        assert!(
            difference.is_none(),
            "{} holds every acknowledged write of both terms: {difference:?}",
            members[at].node_id
        );
    }

    ledger.forwarder.shutdown().await;
    for member in &mut members {
        member.stop().await;
    }
    controller.stop().await;
    coordinator.shutdown().await;
}
