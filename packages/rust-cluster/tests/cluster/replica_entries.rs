use std::path::Path;
use std::sync::Arc;

use narsil::replication::PartitionCopies;
use narsil::{IndexConfig, Map, Narsil, Value};
use narsil_cluster::coordinator::AllocationTable;
use narsil_cluster::coordinator::etcd::{EtcdCoordinator, EtcdCoordinatorConfig};
use narsil_cluster::message::TransportMessage;
use narsil_cluster::transport::NodeTransport;
use narsil_cluster::transport::tcp::{TcpTransport, TcpTransportConfig};

use crate::child_node::{ChildNode, registered_address};
use crate::data_node::{
    DataNode, Scratch, cluster_coordinator, coordinator_at, create_cluster_index, engine_config,
    etcd_endpoint, eventually, title_schema, unique_key_prefix,
};
use crate::support::{Decoded, decode, write_binary, write_map_header, write_text};

const LEDGER: &str = "ledger";
const LEDGER_UUID: &str = "uuid-of-the-ledger";
const REPLICA: &str = "replica-b";
const PRIMARY: &str = "test-primary";
const INTRUDER: &str = "another-data-node";
const PRIMARY_TERM: u64 = 2;
const ENTRY: &str = "replication.entry";
const ENTRY_BATCH: &str = "replication.entry_batch";
const TERM_START: &str = "replication.term_start";
const ACK: &str = "replication.ack";
const TERM_START_ACK: &str = "replication.term_start_ack";
const CRC32_POLYNOMIAL: u32 = 0xedb8_8320;
const HOSTILE_NIL_ENTRIES: u32 = 60_000_000;
const ADDRESS_SPACE_HEADROOM_BYTES: u64 = 3 * 1_024 * 1_024 * 1_024;

fn write_count(out: &mut Vec<u8>, number: u64) {
    match number {
        0..=0x7f => out.push(number as u8),
        0x80..=0xff => {
            out.push(0xcc);
            out.push(number as u8);
        }
        0x100..=0xffff => {
            out.push(0xcd);
            out.extend_from_slice(&(number as u16).to_be_bytes());
        }
        0x1_0000..=0xffff_ffff => {
            out.push(0xce);
            out.extend_from_slice(&(number as u32).to_be_bytes());
        }
        _ => {
            out.push(0xcf);
            out.extend_from_slice(&number.to_be_bytes());
        }
    }
}

fn write_array_header(out: &mut Vec<u8>, count: usize) {
    assert!(count < 16, "the test writes short arrays only");
    out.push(0x90 | count as u8);
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = u32::MAX;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (CRC32_POLYNOMIAL & mask);
        }
    }
    !crc
}

#[derive(Clone)]
struct Entry {
    seq_no: u64,
    primary_term: u64,
    document_id: &'static str,
    title: Option<&'static str>,
    checksum_offset: u32,
}

impl Entry {
    fn index(seq_no: u64, document_id: &'static str, title: &'static str) -> Entry {
        Entry {
            seq_no,
            primary_term: PRIMARY_TERM,
            document_id,
            title: Some(title),
            checksum_offset: 0,
        }
    }

    fn delete(seq_no: u64, document_id: &'static str) -> Entry {
        Entry {
            seq_no,
            primary_term: PRIMARY_TERM,
            document_id,
            title: None,
            checksum_offset: 0,
        }
    }

    fn under(mut self, primary_term: u64) -> Entry {
        self.primary_term = primary_term;
        self
    }

    fn garbled(mut self) -> Entry {
        self.checksum_offset = 1;
        self
    }

    fn operation(&self) -> &'static str {
        if self.title.is_some() {
            "INDEX"
        } else {
            "DELETE"
        }
    }

    fn document(&self) -> Option<Vec<u8>> {
        let title = self.title?;
        let mut out = Vec::new();
        write_map_header(&mut out, 1);
        write_text(&mut out, "title");
        write_text(&mut out, title);
        Some(out)
    }

    fn write_document(&self, out: &mut Vec<u8>) {
        match self.document() {
            Some(document) => write_binary(out, &document),
            None => out.push(0xc0),
        }
    }

    fn checksum(&self) -> u32 {
        let mut fields = Vec::new();
        write_array_header(&mut fields, 7);
        write_count(&mut fields, self.seq_no);
        write_count(&mut fields, self.primary_term);
        write_text(&mut fields, self.operation());
        write_count(&mut fields, 0);
        write_text(&mut fields, LEDGER);
        write_text(&mut fields, self.document_id);
        self.write_document(&mut fields);
        crc32(&fields).wrapping_add(self.checksum_offset)
    }

    fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        write_map_header(&mut out, 8);
        write_text(&mut out, "seqNo");
        write_count(&mut out, self.seq_no);
        write_text(&mut out, "primaryTerm");
        write_count(&mut out, self.primary_term);
        write_text(&mut out, "operation");
        write_text(&mut out, self.operation());
        write_text(&mut out, "partitionId");
        write_count(&mut out, 0);
        write_text(&mut out, "indexName");
        write_text(&mut out, LEDGER);
        write_text(&mut out, "documentId");
        write_text(&mut out, self.document_id);
        write_text(&mut out, "document");
        self.write_document(&mut out);
        write_text(&mut out, "checksum");
        write_count(&mut out, u64::from(self.checksum()));
        out
    }
}

fn run_payload(entries: &[Entry], uuid: &str, previous: Option<u64>) -> (&'static str, Vec<u8>) {
    let mut out = Vec::new();
    write_map_header(&mut out, 2 + usize::from(previous.is_some()));
    let message_type = if let [only] = entries {
        write_text(&mut out, "entry");
        out.extend_from_slice(&only.encode());
        ENTRY
    } else {
        write_text(&mut out, "entries");
        write_array_header(&mut out, entries.len());
        for entry in entries {
            out.extend_from_slice(&entry.encode());
        }
        ENTRY_BATCH
    };
    write_text(&mut out, "indexUuid");
    write_text(&mut out, uuid);
    if let Some(previous) = previous {
        write_text(&mut out, "previousPrimaryTerm");
        write_count(&mut out, previous);
    }
    (message_type, out)
}

fn term_start_payload(primary_term: u64) -> Vec<u8> {
    let mut out = Vec::new();
    write_map_header(&mut out, 6);
    write_text(&mut out, "indexName");
    write_text(&mut out, LEDGER);
    write_text(&mut out, "partitionId");
    write_count(&mut out, 0);
    write_text(&mut out, "primaryTerm");
    write_count(&mut out, primary_term);
    write_text(&mut out, "lastSeqNo");
    write_count(&mut out, 0);
    write_text(&mut out, "lastPrimaryTerm");
    write_count(&mut out, 0);
    write_text(&mut out, "indexUuid");
    write_text(&mut out, LEDGER_UUID);
    out
}

fn replica_assignment(primary_term: u64) -> Map {
    let mut assignment = Map::new();
    assignment.insert("primary", Value::from(PRIMARY));
    assignment.insert("replicas", Value::Array(vec![Value::from(REPLICA)]));
    assignment.insert("inSyncSet", Value::Array(vec![Value::from(REPLICA)]));
    assignment.insert("commitPoint", Value::from(0.0));
    assignment.insert("state", Value::from("ACTIVE"));
    assignment.insert("primaryTerm", Value::from(primary_term as f64));
    assignment
}

async fn store_table(coordinator: &EtcdCoordinator, version: f64, primary_term: u64) {
    let table = AllocationTable {
        index_name: LEDGER.to_string(),
        version,
        replication_factor: 1.0,
        assignments: vec![(0.0, replica_assignment(primary_term))],
        generation: None,
        index_uuid: Some(LEDGER_UUID.to_string()),
    };
    coordinator
        .put_allocation(LEDGER, &table)
        .await
        .expect("etcd takes the table");
}

fn store_empty_replica_copy(directory: &Path) {
    let engine = Narsil::open(engine_config(directory)).expect("the engine opens");
    PartitionCopies::new(&engine)
        .create_index(LEDGER, IndexConfig::new(title_schema()), LEDGER_UUID, 1)
        .expect("the copy is created");
    engine.shutdown().expect("the engine closes");
}

struct TestPrimary {
    transport: TcpTransport,
    target: String,
    serial: std::cell::Cell<u64>,
}

impl TestPrimary {
    fn new(target: &str) -> TestPrimary {
        TestPrimary {
            transport: TcpTransport::new(
                PRIMARY,
                TcpTransportConfig {
                    host: "127.0.0.1".to_string(),
                    port: 0,
                    ..TcpTransportConfig::default()
                },
            )
            .expect("the test primary's transport settings are valid"),
            target: target.to_string(),
            serial: std::cell::Cell::new(0),
        }
    }

    async fn send_as(
        &self,
        source: &str,
        message_type: &str,
        payload: Vec<u8>,
    ) -> (String, Decoded) {
        self.serial.set(self.serial.get() + 1);
        let request_id = format!("request-{}", self.serial.get());
        let answer = self
            .transport
            .send(
                &self.target,
                TransportMessage::new(message_type, source, request_id.as_str(), payload),
            )
            .await
            .expect("the replica answers");
        assert_eq!(answer.request_id, request_id);
        assert_eq!(answer.source_id, REPLICA);
        (answer.message_type, decode(&answer.payload))
    }

    async fn entries(&self, entries: &[Entry], previous: Option<u64>) -> (String, Decoded) {
        let (message_type, payload) = run_payload(entries, LEDGER_UUID, previous);
        self.send_as(PRIMARY, message_type, payload).await
    }

    async fn acknowledged(&self, entries: &[Entry], previous: Option<u64>) {
        let (message_type, answer) = self.entries(entries, previous).await;
        assert_eq!(message_type, ACK, "the replica refused: {answer:?}");
        let last = entries.last().expect("the run holds an entry");
        assert_eq!(answer.unsigned("seqNo"), last.seq_no);
        assert_eq!(answer.unsigned("partitionId"), 0);
        assert_eq!(answer.text("indexName"), LEDGER);
    }

    async fn refused(&self, entries: &[Entry], previous: Option<u64>) -> (String, Decoded) {
        let (message_type, answer) = self.entries(entries, previous).await;
        refusal_of(&message_type, answer)
    }

    async fn term_start(&self, primary_term: u64) -> (String, Decoded) {
        self.send_as(PRIMARY, TERM_START, term_start_payload(primary_term))
            .await
    }
}

fn refusal_of(message_type: &str, answer: Decoded) -> (String, Decoded) {
    assert!(
        message_type.ends_with(".error"),
        "the replica accepted: {answer:?}"
    );
    assert_eq!(answer.field("error"), Some(&Decoded::Bool(true)));
    (answer.text("code"), answer)
}

fn titled(title: &str) -> Map {
    let mut document = Map::new();
    document.insert("title", Value::from(title));
    document
}

async fn held(replica: &DataNode, document_id: &str) -> Option<Map> {
    replica
        .node
        .local_document(LEDGER, document_id)
        .await
        .expect("the replica reads its copy")
}

async fn start_replica(
    coordinator: &Arc<EtcdCoordinator>,
    scratch: &Scratch,
) -> (DataNode, TestPrimary) {
    let replica = DataNode::start(coordinator, REPLICA, scratch.path()).await;
    let primary = TestPrimary::new(&replica.address);
    (replica, primary)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_replica_applies_entries_in_log_order_and_refuses_what_breaks_the_log() {
    let Some(coordinator) = cluster_coordinator().await else {
        return;
    };
    let scratch = Scratch::new();
    store_empty_replica_copy(scratch.path());
    create_cluster_index(&coordinator, LEDGER, LEDGER_UUID, 1, 1).await;
    store_table(&coordinator, 1.0, PRIMARY_TERM).await;
    let (replica, primary) = start_replica(&coordinator, &scratch).await;

    let (message_type, held_end) = primary.term_start(PRIMARY_TERM).await;
    assert_eq!(message_type, TERM_START_ACK, "{held_end:?}");
    assert_eq!(held_end.unsigned("lastSeqNo"), 0);
    assert_eq!(held_end.unsigned("lastPrimaryTerm"), 0);

    let first = Entry::index(1, "invoice-1", "first invoice");
    primary.acknowledged(&[first], None).await;
    assert_eq!(
        held(&replica, "invoice-1").await,
        Some(titled("first invoice"))
    );
    let run = [
        Entry::index(2, "invoice-2", "second invoice"),
        Entry::delete(3, "invoice-1"),
    ];
    primary.acknowledged(&run, Some(PRIMARY_TERM)).await;
    assert_eq!(held(&replica, "invoice-1").await, None);
    assert_eq!(
        held(&replica, "invoice-2").await,
        Some(titled("second invoice"))
    );
    primary.acknowledged(&run[1..], Some(PRIMARY_TERM)).await;

    let rewritten = Entry::index(3, "invoice-1", "a different third entry");
    let (code, answer) = primary.refused(&[rewritten], Some(PRIMARY_TERM)).await;
    assert_eq!(code, "REPLICATION_ENTRY_INVALID", "{answer:?}");
    let gap = Entry::index(5, "invoice-5", "after a gap");
    let (code, answer) = primary.refused(&[gap], Some(PRIMARY_TERM)).await;
    assert_eq!(code, "REPLICATION_ENTRY_INVALID");
    assert_eq!(
        answer
            .field("details")
            .map(|details| details.unsigned("expectedSeqNo")),
        Some(4)
    );
    let garbled = Entry::index(4, "invoice-4", "garbled").garbled();
    let (code, _) = primary.refused(&[garbled], Some(PRIMARY_TERM)).await;
    assert_eq!(code, "REPLICATION_ENTRY_CORRUPT");
    let follows_other_term = Entry::index(4, "invoice-4", "after another history");
    let (code, answer) = primary
        .refused(std::slice::from_ref(&follows_other_term), Some(1))
        .await;
    assert_eq!(code, "REPLICATION_ENTRY_INVALID");
    let details = answer
        .field("details")
        .expect("the refusal carries details");
    assert_eq!(details.unsigned("heldPrimaryTerm"), PRIMARY_TERM);
    let newer_than_table = Entry::index(4, "invoice-4", "from the future").under(PRIMARY_TERM + 1);
    let (code, _) = primary
        .refused(&[newer_than_table], Some(PRIMARY_TERM))
        .await;
    assert_eq!(code, "REPLICATION_TERM_MISMATCH");
    let (other_type, other_payload) =
        run_payload(std::slice::from_ref(&follows_other_term), LEDGER_UUID, None);
    let (message_type, answer) = primary.send_as(INTRUDER, other_type, other_payload).await;
    assert_eq!(
        refusal_of(&message_type, answer).0,
        "REPLICATION_ENTRY_INVALID"
    );
    let (earlier_type, earlier_payload) =
        run_payload(&[follows_other_term], "uuid-of-an-earlier-ledger", None);
    let (message_type, answer) = primary
        .send_as(PRIMARY, earlier_type, earlier_payload)
        .await;
    assert_eq!(refusal_of(&message_type, answer).0, "INDEX_NOT_FOUND");
    let (message_type, answer) = primary.send_as(PRIMARY, ENTRY, vec![0xc1, 0x00]).await;
    assert_eq!(
        refusal_of(&message_type, answer).0,
        "TRANSPORT_DECODE_FAILED"
    );
    assert_eq!(held(&replica, "invoice-4").await, None);

    let (message_type, held_end) = primary.term_start(PRIMARY_TERM).await;
    assert_eq!(message_type, TERM_START_ACK);
    assert_eq!(held_end.unsigned("lastSeqNo"), 3);
    assert_eq!(held_end.unsigned("lastPrimaryTerm"), PRIMARY_TERM);

    store_table(&coordinator, 2.0, PRIMARY_TERM - 1).await;
    let stale = Entry::index(4, "invoice-4", "from a deposed primary").under(PRIMARY_TERM - 1);
    eventually(
        "the replica refuses a primary below the term it accepted",
        || async {
            let (code, answer) = primary.refused(std::slice::from_ref(&stale), None).await;
            assert_eq!(code, "REPLICATION_TERM_MISMATCH", "{answer:?}");
            answer
                .field("details")
                .and_then(|details| details.field("knownTerm"))
                .is_some()
        },
    )
    .await;
    store_table(&coordinator, 3.0, PRIMARY_TERM).await;

    replica.stop().await;
    let (replica, primary) = start_replica(&coordinator, &scratch).await;
    assert_eq!(
        held(&replica, "invoice-2").await,
        Some(titled("second invoice"))
    );
    primary.acknowledged(&run[1..], Some(PRIMARY_TERM)).await;
    let (code, _) = primary
        .refused(
            &[Entry::delete(3, "invoice-1").under(1)],
            Some(PRIMARY_TERM),
        )
        .await;
    assert_eq!(code, "REPLICATION_ENTRY_INVALID");
    primary
        .acknowledged(
            &[Entry::index(4, "invoice-4", "fourth invoice")],
            Some(PRIMARY_TERM),
        )
        .await;
    assert_eq!(
        held(&replica, "invoice-4").await,
        Some(titled("fourth invoice"))
    );

    replica.stop().await;
    coordinator.shutdown().await;
}

fn entry_batch_of_nils(nil_entries: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(nil_entries as usize + 64);
    write_map_header(&mut out, 2);
    write_text(&mut out, "entries");
    out.push(0xdd);
    out.extend_from_slice(&nil_entries.to_be_bytes());
    out.resize(out.len() + nil_entries as usize, 0xc0);
    write_text(&mut out, "indexUuid");
    write_text(&mut out, LEDGER_UUID);
    out
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_replica_refuses_an_entry_batch_of_millions_of_nils_within_a_bounded_address_space()
{
    let Some(endpoint) = etcd_endpoint() else {
        return;
    };
    let key_prefix = unique_key_prefix();
    let ttl = EtcdCoordinatorConfig::default().node_heartbeat_ttl_seconds;
    let coordinator = coordinator_at(endpoint.clone(), key_prefix.clone(), ttl).await;
    let scratch = Scratch::new();
    store_empty_replica_copy(scratch.path());
    create_cluster_index(&coordinator, LEDGER, LEDGER_UUID, 1, 1).await;
    store_table(&coordinator, 1.0, PRIMARY_TERM).await;
    let mut replica = ChildNode::spawn(&endpoint, &key_prefix, REPLICA, &scratch);
    eventually("the replica's process registers its node", || async {
        registered_address(&coordinator, REPLICA).await.is_some()
    })
    .await;
    let address = registered_address(&coordinator, REPLICA)
        .await
        .expect("the replica is registered");
    let primary = TestPrimary::new(&address);
    eventually("the replica accepts the term", || async {
        primary.term_start(PRIMARY_TERM).await.0 == TERM_START_ACK
    })
    .await;
    primary
        .acknowledged(&[Entry::index(1, "invoice-1", "before the limit")], None)
        .await;
    replica.limit_address_space_to_current_plus(ADDRESS_SPACE_HEADROOM_BYTES);

    let (message_type, answer) = primary
        .send_as(
            PRIMARY,
            ENTRY_BATCH,
            entry_batch_of_nils(HOSTILE_NIL_ENTRIES),
        )
        .await;

    assert_eq!(
        refusal_of(&message_type, answer).0,
        "REPLICATION_ENTRY_INVALID"
    );
    primary
        .acknowledged(
            &[Entry::index(2, "invoice-2", "after the hostile batch")],
            Some(PRIMARY_TERM),
        )
        .await;
    let (message_type, held_end) = primary.term_start(PRIMARY_TERM).await;
    assert_eq!(message_type, TERM_START_ACK, "{held_end:?}");
    assert_eq!(held_end.unsigned("lastSeqNo"), 2);
    assert!(!replica.has_exited(), "the replica's process keeps running");
    primary.transport.shutdown().await;
    replica.kill();
    coordinator.shutdown().await;
}
