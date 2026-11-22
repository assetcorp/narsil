use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use narsil::replication::{EntryOperation, PartitionCopies, ReplicatedEntry};
use narsil::{Narsil, Value};
use narsil_cluster::coordinator::etcd::EtcdCoordinator;
use narsil_cluster::message::TransportMessage;
use narsil_cluster::transport::NodeTransport;
use narsil_cluster::transport::tcp::{TcpTransport, TcpTransportConfig};

mod data_node;
mod support;

use data_node::{
    DataNode, Scratch, cluster_coordinator, create_cluster_index, engine_config, eventually,
};
use support::{Decoded, decode, write_binary, write_map_header, write_text};

const LEDGER: &str = "ledger";
const LEDGER_UUID: &str = "uuid-of-the-ledger";
const CONTROLLER: &str = "ledger-controller";
const FIRST_DATA_NODE: &str = "ledger-data-a";
const SECOND_DATA_NODE: &str = "ledger-data-b";
const FORWARDER: &str = "ledger-forwarder";
const FORWARD: &str = "replication.forward";
const BOOTSTRAP_FAILED: &str = "NODE_BOOTSTRAP_FAILED";
const PRIMARY_ERROR: &str = "SNAPSHOT_SYNC_PRIMARY_ERROR";
const SNAPSHOT_FAILED: &str = "SNAPSHOT_SYNC_SNAPSHOT_FAILED";
const REFUSED_SYNCS_TO_WATCH: usize = 3;
const REFUSED_SYNCS_WAIT: Duration = Duration::from_secs(60);
const PAUSE_BETWEEN_WRITES: Duration = Duration::from_millis(250);
const PROMOTION_WAIT: Duration = Duration::from_secs(30);
const DIVERGED_DOCUMENT_ID: &str = "written-only-on-the-departed-primary";

struct Placement {
    state: String,
    primary: String,
    primary_term: f64,
    replicas: Vec<String>,
    in_sync: Vec<String>,
}

impl Placement {
    fn replica(&self) -> Option<&str> {
        self.replicas.first().map(String::as_str)
    }

    fn lists_in_sync(&self, node_id: &str) -> bool {
        self.in_sync.iter().any(|member| member == node_id)
    }

    fn admits(&self, node_id: &str) -> bool {
        self.state == "ACTIVE" && self.lists_in_sync(node_id)
    }

    fn admits_its_replica(&self) -> bool {
        self.replica().is_some_and(|replica| self.admits(replica))
    }
}

fn texts(assignment: &narsil::Map, name: &str) -> Vec<String> {
    match assignment.get(name) {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

async fn placement(coordinator: &EtcdCoordinator) -> Option<Placement> {
    let table = coordinator
        .allocation(LEDGER)
        .await
        .expect("etcd answers for the table")?;
    let (_, assignment) = table.assignments.first()?;
    Some(Placement {
        state: assignment.get("state")?.as_str()?.to_string(),
        primary: assignment.get("primary")?.as_str()?.to_string(),
        primary_term: assignment.get("primaryTerm")?.as_f64()?,
        replicas: texts(assignment, "replicas"),
        in_sync: texts(assignment, "inSyncSet"),
    })
}

struct Member {
    node_id: &'static str,
    scratch: Scratch,
    running: Option<DataNode>,
}

impl Member {
    async fn start(coordinator: &Arc<EtcdCoordinator>, node_id: &'static str) -> Member {
        let mut member = Member {
            node_id,
            scratch: Scratch::new(),
            running: None,
        };
        member.restart(coordinator).await;
        member
    }

    async fn restart(&mut self, coordinator: &Arc<EtcdCoordinator>) {
        let started = DataNode::start(coordinator, self.node_id, self.scratch.path()).await;
        self.running = Some(started);
    }

    async fn stop(&mut self) {
        if let Some(running) = self.running.take() {
            running.stop().await;
        }
    }

    fn data(&self) -> &DataNode {
        self.running.as_ref().expect("the member is running")
    }

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

    fn diverge_while_stopped(&self, title: &str) -> (u64, u64) {
        assert!(self.running.is_none(), "{} is stopped", self.node_id);
        let engine = Narsil::open(engine_config(self.scratch.path())).expect("the engine opens");
        let copies = PartitionCopies::new(&engine);
        let position = copies.position(LEDGER, 0).expect("the copy has a position");
        let entry = ReplicatedEntry {
            seq_no: position.seq_no + 1,
            primary_term: position.primary_term,
            operation: EntryOperation::Index,
            document_id: DIVERGED_DOCUMENT_ID.to_string(),
            document: Some(title_document(title)),
            previous_document: Some(None),
        };
        let appended = copies
            .append(LEDGER, 0, std::slice::from_ref(&entry))
            .expect("the copy takes the entry");
        assert_eq!(appended.applied, 1, "{:?}", appended.failure);
        engine.shutdown().expect("the engine closes");
        (entry.seq_no, entry.primary_term)
    }
}

fn title_document(title: &str) -> Vec<u8> {
    let mut document = Vec::new();
    write_map_header(&mut document, 1);
    write_text(&mut document, "title");
    write_text(&mut document, title);
    document
}

fn insert_payload(document_id: &str, title: &str) -> Vec<u8> {
    let mut out = Vec::new();
    write_map_header(&mut out, 5);
    write_text(&mut out, "indexName");
    write_text(&mut out, LEDGER);
    write_text(&mut out, "documentId");
    write_text(&mut out, document_id);
    write_text(&mut out, "operation");
    write_text(&mut out, "insert");
    write_text(&mut out, "document");
    write_binary(&mut out, &title_document(title));
    write_text(&mut out, "indexUuid");
    write_text(&mut out, LEDGER_UUID);
    out
}

struct Ledger {
    forwarder: TcpTransport,
    written: BTreeMap<String, String>,
}

impl Ledger {
    fn new() -> Ledger {
        let forwarder = TcpTransport::new(
            FORWARDER,
            TcpTransportConfig {
                host: "127.0.0.1".to_string(),
                port: 0,
                ..TcpTransportConfig::default()
            },
        )
        .expect("the forwarder's transport settings are valid");
        Ledger {
            forwarder,
            written: BTreeMap::new(),
        }
    }

    async fn forward(&mut self, primary: &DataNode, document_id: &str) -> Result<(), Decoded> {
        let title = format!("entry {document_id}");
        let request = TransportMessage::new(
            FORWARD,
            FORWARDER,
            document_id,
            insert_payload(document_id, &title),
        );
        let answer = self
            .forwarder
            .send(&primary.address, request)
            .await
            .expect("the primary answers the forward");
        let decoded = decode(&answer.payload);
        if answer.message_type != FORWARD || decoded.field("success") != Some(&Decoded::Bool(true))
        {
            return Err(decoded);
        }
        self.written.insert(document_id.to_string(), title);
        Ok(())
    }

    async fn insert_all(&mut self, primary: &DataNode, document_ids: &[String]) {
        for document_id in document_ids {
            if let Err(refused) = self.forward(primary, document_id).await {
                panic!("the primary refused {document_id}: {refused:?}");
            }
        }
    }

    async fn insert_until_accepted(&mut self, primary: &DataNode, document_id: &str) {
        let deadline = Instant::now() + PROMOTION_WAIT;
        while let Err(refused) = self.forward(primary, document_id).await {
            assert!(
                Instant::now() < deadline,
                "the promoted primary still refuses writes: {refused:?}"
            );
            tokio::time::sleep(PAUSE_BETWEEN_WRITES).await;
        }
    }

    fn written_outside(&self, kept: &BTreeMap<String, String>) -> Vec<String> {
        self.written
            .keys()
            .filter(|document_id| !kept.contains_key(*document_id))
            .cloned()
            .collect()
    }
}

fn document_ids(prefix: &str, count: usize) -> Vec<String> {
    (0..count)
        .map(|serial| format!("{prefix}-{serial}"))
        .collect()
}

async fn first_difference(
    node: &DataNode,
    written: &BTreeMap<String, String>,
    absent: &[String],
) -> Option<String> {
    for (document_id, title) in written {
        let held = node.node.local_document(LEDGER, document_id).await;
        let matches = matches!(
            &held,
            Ok(Some(document)) if document.get("title").and_then(Value::as_str) == Some(title.as_str())
        );
        if !matches {
            return Some(format!(
                "{document_id} should read '{title}' and reads {held:?}"
            ));
        }
    }
    for document_id in absent {
        let held = node.node.local_document(LEDGER, document_id).await;
        if !matches!(held, Ok(None)) {
            return Some(format!("{document_id} should be absent and reads {held:?}"));
        }
    }
    None
}

async fn holds_exactly(
    node: &DataNode,
    written: &BTreeMap<String, String>,
    absent: &[String],
) -> bool {
    first_difference(node, written, absent).await.is_none()
}

async fn start_controller(coordinator: &Arc<EtcdCoordinator>, scratch: &Scratch) -> DataNode {
    DataNode::start_with_roles(coordinator, CONTROLLER, scratch.path(), &["controller"]).await
}

async fn start_cluster(
    coordinator: &Arc<EtcdCoordinator>,
    controller_scratch: &Scratch,
) -> (DataNode, [Member; 2], usize) {
    let controller = start_controller(coordinator, controller_scratch).await;
    let members = [
        Member::start(coordinator, FIRST_DATA_NODE).await,
        Member::start(coordinator, SECOND_DATA_NODE).await,
    ];
    create_cluster_index(coordinator, LEDGER, LEDGER_UUID, 1, 1).await;
    eventually("the replica syncs and joins the in-sync set", || async {
        placement(coordinator)
            .await
            .is_some_and(|placed| placed.admits_its_replica())
    })
    .await;
    let placed = placement(coordinator).await.expect("the ledger is placed");
    let primary_at = members
        .iter()
        .position(|member| member.node_id == placed.primary)
        .expect("a data node leads the ledger");
    (controller, members, primary_at)
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
