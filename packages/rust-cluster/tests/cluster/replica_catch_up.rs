use narsil_cluster::transport::NodeTransport;

use crate::data_node::{Scratch, cluster_coordinator, eventually};
use crate::ledger::{
    DIVERGED_DOCUMENT_ID, LEDGER, Ledger, document_ids, holds_exactly, placement, start_cluster,
};

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_replica_catches_up_from_a_rust_primary_and_takes_a_snapshot_once_it_falls_past_the_retained_log()
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
        .insert_all(members[primary_at].data(), &document_ids("admitted", 4))
        .await;
    for member in &members {
        assert!(
            holds_exactly(member.data(), &ledger.written, &[]).await,
            "{} holds every acknowledged write",
            member.node_id
        );
    }

    members[replica_at].stop().await;
    ledger
        .insert_all(members[primary_at].data(), &document_ids("while-away", 5))
        .await;
    let removed = placement(&coordinator).await.expect("the ledger is placed");
    assert!(!removed.lists_in_sync(replica_id));
    members[replica_at].restart(&coordinator).await;
    eventually("the returning replica is admitted again", || async {
        placement(&coordinator)
            .await
            .is_some_and(|placed| placed.admits(replica_id))
    })
    .await;
    assert!(
        holds_exactly(members[replica_at].data(), &ledger.written, &[]).await,
        "the returning replica holds every acknowledged write"
    );

    members[replica_at].stop().await;
    ledger
        .insert_all(members[primary_at].data(), &document_ids("past-the-log", 3))
        .await;
    members[primary_at].stop().await;
    members[primary_at].restart(&coordinator).await;
    members[replica_at].restart(&coordinator).await;
    ledger
        .insert_until_accepted(members[primary_at].data(), "the-restarted-primary-serves")
        .await;
    eventually(
        "the replica that fell past the retained log is admitted after a snapshot",
        || async {
            placement(&coordinator)
                .await
                .is_some_and(|placed| placed.admits(replica_id))
        },
    )
    .await;
    ledger
        .insert_all(
            members[primary_at].data(),
            &document_ids("after-snapshot", 3),
        )
        .await;
    for member in &members {
        assert!(
            holds_exactly(member.data(), &ledger.written, &[]).await,
            "{} holds every acknowledged write",
            member.node_id
        );
    }

    ledger.forwarder.shutdown().await;
    for member in &mut members {
        member.stop().await;
    }
    controller.stop().await;
    coordinator.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_replica_holding_an_entry_from_an_earlier_term_takes_a_snapshot_that_drops_the_entry() {
    let Some(coordinator) = cluster_coordinator().await else {
        return;
    };
    let controller_scratch = Scratch::new();
    let (controller, mut members, departed_at) =
        start_cluster(&coordinator, &controller_scratch).await;
    let successor_at = 1 - departed_at;
    let (successor_id, departed_id) = (members[successor_at].node_id, members[departed_at].node_id);
    let mut ledger = Ledger::new();

    ledger
        .insert_all(
            members[departed_at].data(),
            &document_ids("before-failover", 3),
        )
        .await;
    let first_term = placement(&coordinator)
        .await
        .expect("the ledger is placed")
        .primary_term;
    members[departed_at].stop().await;
    eventually(
        "the controller promotes the in-sync replica and keeps the departed primary as its replica",
        || async {
            placement(&coordinator).await.is_some_and(|placed| {
                placed.primary == successor_id && placed.replica() == Some(departed_id)
            })
        },
    )
    .await;
    let promoted_term = placement(&coordinator)
        .await
        .expect("the ledger is placed")
        .primary_term;
    assert!(promoted_term > first_term);
    let diverged_title = "written by the departed primary and never replicated";
    let (_, diverged_term) = members[departed_at].diverge_while_stopped(diverged_title);
    assert!((diverged_term as f64) < promoted_term);
    ledger
        .insert_until_accepted(members[successor_at].data(), "after-failover")
        .await;
    members[departed_at].restart(&coordinator).await;
    eventually(
        "the departed primary is admitted as a replica after a snapshot",
        || async {
            placement(&coordinator)
                .await
                .is_some_and(|placed| placed.admits(departed_id))
        },
    )
    .await;
    assert!(
        holds_exactly(
            members[departed_at].data(),
            &ledger.written,
            &[DIVERGED_DOCUMENT_ID.to_string()]
        )
        .await,
        "the departed primary holds every acknowledged write and drops the entry that only it wrote"
    );
    assert!(
        matches!(
            members[successor_at]
                .data()
                .node
                .local_document(LEDGER, DIVERGED_DOCUMENT_ID)
                .await,
            Ok(None)
        ),
        "the successor never takes the entry that only the departed primary wrote"
    );
    let settled = placement(&coordinator).await.expect("the ledger is placed");
    assert_eq!(settled.primary_term, promoted_term);

    ledger.forwarder.shutdown().await;
    for member in &mut members {
        member.stop().await;
    }
    controller.stop().await;
    coordinator.shutdown().await;
}
