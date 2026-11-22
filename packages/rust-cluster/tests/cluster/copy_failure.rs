use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use narsil_cluster::coordinator::etcd::EtcdCoordinator;
use narsil_cluster::transport::NodeTransport;
use narsil_cluster::transport::tcp::TcpTransport;

use crate::child_node::{ChildNode, file_sizes, registered_address};
use crate::data_node::{
    DataNode, Scratch, cluster_coordinator, coordinator_at, create_cluster_index, etcd_endpoint,
    eventually, unique_key_prefix,
};
use crate::ledger::{
    FIRST_DATA_NODE, Forwarded, LEDGER, LEDGER_UUID, Ledger, Member, PAUSE_BETWEEN_WRITES,
    SECOND_DATA_NODE, first_difference, forward_insert, forward_write, forwarder, placement,
    start_controller, title_of,
};
use crate::support::Decoded;

const PARENT_HEARTBEAT_TTL_SECONDS: u64 = 30;
const OUTCOME_UNKNOWN: &str = "REPLICATION_OUTCOME_UNKNOWN";
const NOT_PRIMARY: &str = "PARTITION_NOT_PRIMARY";
const INITIALISING: &str = "INITIALISING";
const TERM_ENDED: &str = "term_ended";
const CONTESTED: &str = "contested-entry";
const FIRST_TITLE: &str = "title-0";
const SECOND_TITLE: &str = "title-1";
const EVERY_FILE_WRITE_REFUSED_BYTES: u64 = 1;
const FAILED_REPLICA_WATCHED_FOR: Duration = Duration::from_secs(10);

struct Cluster {
    coordinator: Arc<EtcdCoordinator>,
    controller: Option<DataNode>,
    _controller_scratch: Scratch,
    primary: ChildNode,
    primary_scratch: Scratch,
    primary_address: String,
    replica: Option<DataNode>,
    _replica_scratch: Scratch,
    forwarder: TcpTransport,
    acknowledged: BTreeMap<String, String>,
}

impl Cluster {
    async fn start() -> Option<Cluster> {
        let endpoint = etcd_endpoint()?;
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
        let primary = ChildNode::spawn(&endpoint, &key_prefix, FIRST_DATA_NODE, &primary_scratch);
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
        let primary_address = registered_address(&coordinator, FIRST_DATA_NODE)
            .await
            .expect("the primary is registered");
        Some(Cluster {
            coordinator,
            controller: Some(controller),
            _controller_scratch: controller_scratch,
            primary,
            primary_scratch,
            primary_address,
            replica: Some(replica),
            _replica_scratch: replica_scratch,
            forwarder: forwarder(),
            acknowledged: BTreeMap::new(),
        })
    }

    async fn write(&mut self, operation: &str, document_id: &str, title: &str) -> Forwarded {
        let forwarded = forward_write(
            &self.forwarder,
            &self.primary_address,
            operation,
            document_id,
            title,
        )
        .await;
        if matches!(forwarded, Forwarded::Acknowledged) {
            self.acknowledged
                .insert(document_id.to_string(), title.to_string());
        }
        forwarded
    }

    async fn acknowledged_write(&mut self, operation: &str, document_id: &str, title: &str) {
        match self.write(operation, document_id, title).await {
            Forwarded::Acknowledged => {}
            Forwarded::Refused(refused) => panic!("the primary refused {document_id}: {refused:?}"),
            Forwarded::Unreachable => panic!("the primary is unreachable"),
        }
    }

    async fn growth_of_one_write(
        &mut self,
        operation: &str,
        document_id: &str,
        title: &str,
    ) -> (PathBuf, u64, u64) {
        let before = file_sizes(self.primary_scratch.path());
        self.acknowledged_write(operation, document_id, title).await;
        let after = file_sizes(self.primary_scratch.path());
        let grown: Vec<(&PathBuf, u64)> = after
            .iter()
            .filter_map(|(path, size)| {
                let earlier = before.get(path).copied().unwrap_or(0);
                (*size > earlier).then(|| (path, size - earlier))
            })
            .collect();
        let [(log, grew)] = grown.as_slice() else {
            panic!("one write should grow one file of the primary: {before:?} then {after:?}");
        };
        ((*log).clone(), *grew, after[*log])
    }

    async fn stop(mut self) {
        self.primary.kill();
        self.forwarder.shutdown().await;
        if let Some(replica) = self.replica.take() {
            replica.stop().await;
        }
        if let Some(controller) = self.controller.take() {
            controller.stop().await;
        }
        self.coordinator.shutdown().await;
    }
}

fn assert_outcome_unknown_after_an_ended_term(forwarded: Forwarded, document_id: &str) {
    let Forwarded::Refused(refused) = forwarded else {
        panic!("the primary should refuse {document_id} once its disk refuses the write");
    };
    assert_eq!(refused.text("code"), OUTCOME_UNKNOWN, "{refused:?}");
    let reason = refused
        .field("details")
        .and_then(|details| details.field("reason"));
    assert_eq!(
        reason,
        Some(&Decoded::Text(TERM_ENDED.to_string())),
        "{refused:?}"
    );
    assert!(
        refused.field("abandonedWrite").is_none(),
        "the primary appended no compensating entry, so it names no abandoned write: {refused:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_primary_whose_disk_refuses_a_write_answers_outcome_unknown_and_hands_the_partition_to_its_replica()
 {
    let Some(mut cluster) = Cluster::start().await else {
        return;
    };
    for document_id in ["settled-0", "settled-1", "settled-2"] {
        cluster
            .acknowledged_write("insert", document_id, &title_of(document_id))
            .await;
    }
    let (_, _, log_bytes) = cluster
        .growth_of_one_write("insert", "settled-3", &title_of("settled-3"))
        .await;
    cluster.primary.limit_file_size(log_bytes);

    let refused = cluster
        .write("insert", "beyond-the-disk", &title_of("beyond-the-disk"))
        .await;
    assert_outcome_unknown_after_an_ended_term(refused, "beyond-the-disk");
    eventually("the in-sync replica takes over the ledger", || async {
        placement(&cluster.coordinator)
            .await
            .is_some_and(|placed| placed.is_led_by(SECOND_DATA_NODE))
    })
    .await;
    let replica = cluster.replica.as_ref().expect("the replica runs");
    let difference = first_difference(
        replica,
        &cluster.acknowledged,
        &["beyond-the-disk".to_string()],
    )
    .await;
    assert!(
        difference.is_none(),
        "the promoted replica holds every acknowledged write and never the refused one: {difference:?}"
    );
    let mut ledger = Ledger::new();
    ledger
        .insert_until_accepted(replica, "after-the-handover")
        .await;
    ledger.forwarder.shutdown().await;
    cluster.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_primary_whose_disk_refuses_a_compensating_entry_answers_outcome_unknown_without_an_abandoned_write()
 {
    let Some(mut cluster) = Cluster::start().await else {
        return;
    };
    cluster
        .acknowledged_write("insert", CONTESTED, FIRST_TITLE)
        .await;
    let (log, update_bytes, _) = cluster
        .growth_of_one_write("update", CONTESTED, SECOND_TITLE)
        .await;
    let (_, _, log_bytes) = cluster
        .growth_of_one_write("update", CONTESTED, FIRST_TITLE)
        .await;
    if let Some(controller) = cluster.controller.take() {
        controller.stop().await;
    }
    if let Some(replica) = cluster.replica.take() {
        replica.stop().await;
    }
    cluster.primary.limit_file_size(log_bytes + update_bytes);

    let refused = cluster.write("update", CONTESTED, SECOND_TITLE).await;
    assert_outcome_unknown_after_an_ended_term(refused, CONTESTED);
    assert_eq!(
        file_sizes(cluster.primary_scratch.path())[&log],
        log_bytes + update_bytes,
        "the log holds the whole update and none of its compensating entry"
    );
    cluster.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_write_that_reaches_a_new_primary_before_it_builds_its_copy_is_refused_as_initialising_and_leaves_the_partition_writable()
 {
    let Some(coordinator) = cluster_coordinator().await else {
        return;
    };
    let controller_scratch = Scratch::new();
    let controller = start_controller(&coordinator, &controller_scratch).await;
    let mut primary = Member::start(&coordinator, FIRST_DATA_NODE).await;
    create_cluster_index(&coordinator, LEDGER, LEDGER_UUID, 1, 0).await;
    eventually("the controller places the ledger", || async {
        placement(&coordinator).await.is_some()
    })
    .await;
    let mut ledger = Ledger::new();
    let early = "written-while-the-copy-is-built";
    match forward_insert(&ledger.forwarder, &primary.data().address, early).await {
        Forwarded::Acknowledged => {
            ledger.written.insert(early.to_string(), title_of(early));
        }
        Forwarded::Refused(refused) => {
            assert_eq!(refused.text("code"), NOT_PRIMARY, "{refused:?}");
            let state = refused
                .field("details")
                .and_then(|details| details.field("state"));
            assert_eq!(
                state,
                Some(&Decoded::Text(INITIALISING.to_string())),
                "the refusal tells the sender that the partition is still initialising: {refused:?}"
            );
        }
        Forwarded::Unreachable => panic!("the primary is unreachable"),
    }
    eventually("the primary finishes building its copy", || async {
        placement(&coordinator)
            .await
            .is_some_and(|placed| placed.is_led_by(FIRST_DATA_NODE))
    })
    .await;
    ledger
        .insert_until_accepted(primary.data(), "written-once-the-copy-is-built")
        .await;
    let difference = first_difference(primary.data(), &ledger.written, &[]).await;
    assert!(
        difference.is_none(),
        "the primary holds every acknowledged write: {difference:?}"
    );

    ledger.forwarder.shutdown().await;
    primary.stop().await;
    controller.stop().await;
    coordinator.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_replica_whose_disk_refuses_every_write_never_rejoins_the_in_sync_set() {
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
    let mut primary = Member::start(&coordinator, FIRST_DATA_NODE).await;
    create_cluster_index(&coordinator, LEDGER, LEDGER_UUID, 1, 1).await;
    eventually("the first data node leads the ledger", || async {
        placement(&coordinator)
            .await
            .is_some_and(|placed| placed.is_led_by(FIRST_DATA_NODE))
    })
    .await;
    let replica_scratch = Scratch::new();
    let mut replica = ChildNode::spawn(&endpoint, &key_prefix, SECOND_DATA_NODE, &replica_scratch);
    eventually("the replica joins the in-sync set", || async {
        placement(&coordinator)
            .await
            .is_some_and(|placed| placed.admits(SECOND_DATA_NODE))
    })
    .await;
    let mut ledger = Ledger::new();
    ledger
        .insert_all(
            primary.data(),
            &["settled-0".to_string(), "settled-1".to_string()],
        )
        .await;

    replica.limit_file_size(EVERY_FILE_WRITE_REFUSED_BYTES);
    ledger
        .insert_all(primary.data(), &["refused-by-the-replica-disk".to_string()])
        .await;
    eventually("the primary removes the failed replica", || async {
        placement(&coordinator)
            .await
            .is_some_and(|placed| !placed.lists_in_sync(SECOND_DATA_NODE))
    })
    .await;
    let watched_until = Instant::now() + FAILED_REPLICA_WATCHED_FOR;
    let mut serial = 0;
    while Instant::now() < watched_until {
        ledger
            .insert_all(primary.data(), &[format!("after-the-failure-{serial}")])
            .await;
        serial += 1;
        let placed = placement(&coordinator).await.expect("the ledger is placed");
        assert!(
            placed.is_led_by(FIRST_DATA_NODE) && !placed.lists_in_sync(SECOND_DATA_NODE),
            "a replica that cannot make an entry durable stays out of the in-sync set"
        );
        tokio::time::sleep(PAUSE_BETWEEN_WRITES).await;
    }
    let difference = first_difference(primary.data(), &ledger.written, &[]).await;
    assert!(
        difference.is_none(),
        "the primary holds every acknowledged write: {difference:?}"
    );

    replica.kill();
    ledger.forwarder.shutdown().await;
    primary.stop().await;
    controller.stop().await;
    coordinator.shutdown().await;
}
