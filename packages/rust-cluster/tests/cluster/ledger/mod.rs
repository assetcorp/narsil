#![allow(dead_code)]

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use narsil::replication::{EntryOperation, PartitionCopies, ReplicatedEntry};
use narsil::{Narsil, Value};
use narsil_cluster::coordinator::etcd::EtcdCoordinator;
use narsil_cluster::message::TransportMessage;
use narsil_cluster::transport::NodeTransport;
use narsil_cluster::transport::tcp::{TcpTransport, TcpTransportConfig};

use crate::data_node::{DataNode, Scratch, create_cluster_index, engine_config, eventually};
use crate::support::{Decoded, decode, write_binary, write_map_header, write_text};

pub const LEDGER: &str = "ledger";
pub const LEDGER_UUID: &str = "uuid-of-the-ledger";
pub const CONTROLLER: &str = "ledger-controller";
pub const FIRST_DATA_NODE: &str = "ledger-data-a";
pub const SECOND_DATA_NODE: &str = "ledger-data-b";
pub const FORWARDER: &str = "ledger-forwarder";
pub const FORWARD: &str = "replication.forward";
pub const PAUSE_BETWEEN_WRITES: Duration = Duration::from_millis(250);
pub const PROMOTION_WAIT: Duration = Duration::from_secs(30);
pub const DIVERGED_DOCUMENT_ID: &str = "written-only-on-the-departed-primary";

pub struct Placement {
    pub state: String,
    pub primary: String,
    pub primary_term: f64,
    pub replicas: Vec<String>,
    pub in_sync: Vec<String>,
}

impl Placement {
    pub fn replica(&self) -> Option<&str> {
        self.replicas.first().map(String::as_str)
    }

    pub fn lists_in_sync(&self, node_id: &str) -> bool {
        self.in_sync.iter().any(|member| member == node_id)
    }

    pub fn admits(&self, node_id: &str) -> bool {
        self.state == "ACTIVE" && self.lists_in_sync(node_id)
    }

    pub fn is_led_by(&self, node_id: &str) -> bool {
        self.state == "ACTIVE" && self.primary == node_id
    }

    pub fn admits_its_replica(&self) -> bool {
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

pub async fn placement(coordinator: &EtcdCoordinator) -> Option<Placement> {
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

pub struct Member {
    pub node_id: &'static str,
    pub scratch: Scratch,
    pub running: Option<DataNode>,
}

impl Member {
    pub async fn start(coordinator: &Arc<EtcdCoordinator>, node_id: &'static str) -> Member {
        let mut member = Member {
            node_id,
            scratch: Scratch::new(),
            running: None,
        };
        member.restart(coordinator).await;
        member
    }

    pub async fn restart(&mut self, coordinator: &Arc<EtcdCoordinator>) {
        let started = DataNode::start(coordinator, self.node_id, self.scratch.path()).await;
        self.running = Some(started);
    }

    pub async fn stop(&mut self) {
        if let Some(running) = self.running.take() {
            running.stop().await;
        }
    }

    pub async fn cut_off_and_stop(&mut self) {
        if let Some(running) = self.running.take() {
            running.transport.shutdown().await;
            running.node.shutdown().await;
        }
    }

    pub fn data(&self) -> &DataNode {
        self.running.as_ref().expect("the member is running")
    }

    pub fn diverge_while_stopped(&self, title: &str) -> (u64, u64) {
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

pub fn title_document(title: &str) -> Vec<u8> {
    let mut document = Vec::new();
    write_map_header(&mut document, 1);
    write_text(&mut document, "title");
    write_text(&mut document, title);
    document
}

fn write_payload(operation: &str, document_id: &str, title: &str) -> Vec<u8> {
    let mut out = Vec::new();
    write_map_header(&mut out, 5);
    write_text(&mut out, "indexName");
    write_text(&mut out, LEDGER);
    write_text(&mut out, "documentId");
    write_text(&mut out, document_id);
    write_text(&mut out, "operation");
    write_text(&mut out, operation);
    write_text(&mut out, "document");
    write_binary(&mut out, &title_document(title));
    write_text(&mut out, "indexUuid");
    write_text(&mut out, LEDGER_UUID);
    out
}

pub fn title_of(document_id: &str) -> String {
    format!("entry {document_id}")
}

pub fn forwarder() -> TcpTransport {
    TcpTransport::new(
        FORWARDER,
        TcpTransportConfig {
            host: "127.0.0.1".to_string(),
            port: 0,
            ..TcpTransportConfig::default()
        },
    )
    .expect("the forwarder's transport settings are valid")
}

pub enum Forwarded {
    Acknowledged,
    Refused(Decoded),
    Unreachable,
}

pub async fn forward_write(
    forwarder: &TcpTransport,
    address: &str,
    operation: &str,
    document_id: &str,
    title: &str,
) -> Forwarded {
    let request = TransportMessage::new(
        FORWARD,
        FORWARDER,
        document_id,
        write_payload(operation, document_id, title),
    );
    let Ok(answer) = forwarder.send(address, request).await else {
        return Forwarded::Unreachable;
    };
    let decoded = decode(&answer.payload);
    if answer.message_type != FORWARD || decoded.field("success") != Some(&Decoded::Bool(true)) {
        return Forwarded::Refused(decoded);
    }
    Forwarded::Acknowledged
}

pub async fn forward_insert(
    forwarder: &TcpTransport,
    address: &str,
    document_id: &str,
) -> Forwarded {
    forward_write(
        forwarder,
        address,
        "insert",
        document_id,
        &title_of(document_id),
    )
    .await
}

pub struct Ledger {
    pub forwarder: TcpTransport,
    pub written: BTreeMap<String, String>,
}

impl Ledger {
    pub fn new() -> Ledger {
        Ledger {
            forwarder: forwarder(),
            written: BTreeMap::new(),
        }
    }

    async fn forward(&mut self, primary: &DataNode, document_id: &str) -> Result<(), String> {
        match forward_insert(&self.forwarder, &primary.address, document_id).await {
            Forwarded::Acknowledged => {
                self.written
                    .insert(document_id.to_string(), title_of(document_id));
                Ok(())
            }
            Forwarded::Refused(refused) => Err(format!("{refused:?}")),
            Forwarded::Unreachable => Err("the primary is unreachable".to_string()),
        }
    }

    pub async fn insert_all(&mut self, primary: &DataNode, document_ids: &[String]) {
        for document_id in document_ids {
            if let Err(refused) = self.forward(primary, document_id).await {
                panic!("the primary refused {document_id}: {refused}");
            }
        }
    }

    pub async fn insert_until_accepted(&mut self, primary: &DataNode, document_id: &str) {
        let deadline = Instant::now() + PROMOTION_WAIT;
        while let Err(refused) = self.forward(primary, document_id).await {
            assert!(
                Instant::now() < deadline,
                "the primary still refuses writes: {refused}"
            );
            tokio::time::sleep(PAUSE_BETWEEN_WRITES).await;
        }
    }

    pub fn written_outside(&self, kept: &BTreeMap<String, String>) -> Vec<String> {
        self.written
            .keys()
            .filter(|document_id| !kept.contains_key(*document_id))
            .cloned()
            .collect()
    }
}

pub fn document_ids(prefix: &str, count: usize) -> Vec<String> {
    (0..count)
        .map(|serial| format!("{prefix}-{serial}"))
        .collect()
}

pub async fn first_difference(
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

pub async fn holds_exactly(
    node: &DataNode,
    written: &BTreeMap<String, String>,
    absent: &[String],
) -> bool {
    first_difference(node, written, absent).await.is_none()
}

pub async fn start_controller(coordinator: &Arc<EtcdCoordinator>, scratch: &Scratch) -> DataNode {
    DataNode::start_with_roles(coordinator, CONTROLLER, scratch.path(), &["controller"]).await
}

pub async fn start_cluster(
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
