use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use narsil::Value;
use narsil_cluster::coordinator::etcd::EtcdCoordinator;
use narsil_cluster::transport::NodeTransport;

mod data_node;
mod ledger;
mod support;

use data_node::{Scratch, cluster_coordinator, eventually};
use ledger::{
    DIVERGED_DOCUMENT_ID, LEDGER, Ledger, Member, PAUSE_BETWEEN_WRITES, document_ids,
    first_difference, holds_exactly, placement, start_cluster,
};

const BOOTSTRAP_FAILED: &str = "NODE_BOOTSTRAP_FAILED";
const PRIMARY_ERROR: &str = "SNAPSHOT_SYNC_PRIMARY_ERROR";
const SNAPSHOT_FAILED: &str = "SNAPSHOT_SYNC_SNAPSHOT_FAILED";
const REFUSED_SYNCS_TO_WATCH: usize = 3;
const REFUSED_SYNCS_WAIT: Duration = Duration::from_secs(60);

impl Member {
    fn snapshot_refusals(&self) -> usize {
        self.data()
            .reported
            .lock()
            .expect("no reporter panicked")
            .iter()
            .filter(|error| {
                let details = error.details();
                error.code() == BOOTSTRAP_FAILED
                    && details.get("innerCode").and_then(Value::as_str) == Some(PRIMARY_ERROR)
                    && details
                        .get("cause")
                        .and_then(Value::as_str)
                        .is_some_and(|cause| cause.contains(SNAPSHOT_FAILED))
            })
            .count()
    }
}

async fn stays_refused_while_writes_continue(
    coordinator: &EtcdCoordinator,
    ledger: &mut Ledger,
    primary: &Member,
    replica: &Member,
    kept: &BTreeMap<String, String>,
    prefix: &str,
) {
    let deadline = Instant::now() + REFUSED_SYNCS_WAIT;
    let mut serial = 0;
    while replica.snapshot_refusals() < REFUSED_SYNCS_TO_WATCH {
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {} to report {REFUSED_SYNCS_TO_WATCH} syncs that the primary refused for a snapshot",
            replica.node_id
        );
        ledger
            .insert_all(primary.data(), &[format!("{prefix}-{serial}")])
            .await;
        serial += 1;
        let placed = placement(coordinator).await.expect("the ledger is placed");
        assert_eq!(
            placed.primary, primary.node_id,
            "the ledger keeps its primary"
        );
        assert!(
            !placed.lists_in_sync(replica.node_id),
            "{} stays out of the in-sync set",
            replica.node_id
        );
        let difference =
            first_difference(replica.data(), kept, &ledger.written_outside(kept)).await;
        assert!(
            difference.is_none(),
            "{} keeps the copy that it had and takes no write that the primary acknowledged since: {difference:?}, reported {:?}",
            replica.node_id,
            replica
                .data()
                .reported
                .lock()
                .expect("no reporter panicked")
        );
        tokio::time::sleep(PAUSE_BETWEEN_WRITES).await;
    }
    assert!(
        holds_exactly(primary.data(), &ledger.written, &[]).await,
        "{} holds every acknowledged write",
        primary.node_id
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_replica_catches_up_from_a_rust_primary_and_keeps_its_copy_once_it_falls_past_the_retained_log()
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

    let synced = ledger.written.clone();
    members[replica_at].stop().await;
    ledger
        .insert_all(members[primary_at].data(), &document_ids("past-the-log", 3))
        .await;
    members[primary_at].stop().await;
    members[primary_at].restart(&coordinator).await;
    members[replica_at].restart(&coordinator).await;
    stays_refused_while_writes_continue(
        &coordinator,
        &mut ledger,
        &members[primary_at],
        &members[replica_at],
        &synced,
        "after-the-primary-restarted",
    )
    .await;

    ledger.forwarder.shutdown().await;
    for member in &mut members {
        member.stop().await;
    }
    controller.stop().await;
    coordinator.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_replica_holding_an_entry_from_an_earlier_term_is_never_admitted_and_keeps_its_copy() {
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
    let mut kept = ledger.written.clone();
    kept.insert(DIVERGED_DOCUMENT_ID.to_string(), diverged_title.to_string());
    ledger
        .insert_until_accepted(members[successor_at].data(), "after-failover")
        .await;
    members[departed_at].restart(&coordinator).await;
    stays_refused_while_writes_continue(
        &coordinator,
        &mut ledger,
        &members[successor_at],
        &members[departed_at],
        &kept,
        "while-the-departed-primary-retries",
    )
    .await;
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
