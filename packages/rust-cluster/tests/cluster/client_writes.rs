use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use narsil::{Map, Value};
use narsil_cluster::coordinator::AllocationTable;
use narsil_cluster::coordinator::etcd::EtcdCoordinator;
use narsil_cluster::error::ClusterError;
use narsil_cluster::message::TransportMessage;
use narsil_cluster::transport::tcp::{TcpTransport, TcpTransportConfig};
use narsil_cluster::transport::{BoxFuture, NodeTransport, Respond, listen_handler};
use tokio::sync::Notify;

use crate::data_node::{DataNode, Scratch, cluster_coordinator, create_cluster_index};
use crate::ledger::{FORWARDER, forwarder, start_controller, title_document};
use crate::spread::{Expected, copy_difference, fnv1a_partition, settled_holders, titled};
use crate::support::{Decoded, decode, write_binary, write_map_header, write_text};

const INDEX: &str = "client-ledger";
const INDEX_UUID: &str = "uuid-of-the-client-ledger";
const PARTITIONS: u32 = 2;
const FORWARD_BATCH: &str = "replication.forward_batch";
const SPEC_BATCH_LIMIT: usize = 1_000;
const MAX_DOC_ID_UTF16_UNITS: usize = 512;
const VALIDATION_FAILED: &str = "DOC_VALIDATION_FAILED";

fn assert_refused(outcome: Result<impl std::fmt::Debug, ClusterError>, code: &str, what: &str) {
    match outcome {
        Err(error) => assert_eq!(error.code(), code, "{what}: {error:?}"),
        Ok(value) => {
            panic!("{what} should be refused with {code}, and the node answered {value:?}")
        }
    }
}

fn with_id(document_id: &str, title: &str) -> Map {
    let mut document = titled(title);
    document.insert("id", Value::from(document_id));
    document
}

fn oversized_batch(count: usize) -> Vec<u8> {
    let mut out = Vec::new();
    write_map_header(&mut out, 3);
    write_text(&mut out, "indexName");
    write_text(&mut out, INDEX);
    write_text(&mut out, "operations");
    out.push(0xdc);
    out.extend_from_slice(&(count as u16).to_be_bytes());
    for serial in 0..count {
        write_map_header(&mut out, 3);
        write_text(&mut out, "documentId");
        write_text(&mut out, &format!("past-the-limit-{serial}"));
        write_text(&mut out, "operation");
        write_text(&mut out, "insert");
        write_text(&mut out, "document");
        write_binary(&mut out, &title_document("past the limit"));
    }
    write_text(&mut out, "indexUuid");
    write_text(&mut out, INDEX_UUID);
    out
}

#[tokio::test(flavor = "multi_thread")]
async fn the_rust_write_api_routes_each_write_by_its_id_and_refuses_hostile_input() {
    let Some(coordinator) = cluster_coordinator().await else {
        return;
    };
    let controller_scratch = Scratch::new();
    let controller = start_controller(&coordinator, &controller_scratch).await;
    let scratches = [Scratch::new(), Scratch::new(), Scratch::new()];
    let data = [
        DataNode::start(&coordinator, "client-data-a", scratches[0].path()).await,
        DataNode::start(&coordinator, "client-data-b", scratches[1].path()).await,
        DataNode::start(&coordinator, "client-data-c", scratches[2].path()).await,
    ];
    create_cluster_index(&coordinator, INDEX, INDEX_UUID, u64::from(PARTITIONS), 1).await;
    let holders = settled_holders(&coordinator, INDEX, PARTITIONS).await;
    assert!(
        data.iter().any(|member| {
            let node_id = member.node.node_id();
            holders
                .values()
                .filter(|holding| holding.iter().any(|holder| holder == node_id))
                .count()
                == 1
        }),
        "a data node holds one partition alone, so a document routed to the other partition shows up: {holders:?}"
    );
    let router_scratch = Scratch::new();
    let router = DataNode::start_with_roles(
        &coordinator,
        "client-router",
        router_scratch.path(),
        &["coordinator"],
    )
    .await;
    let node = &router.node;
    let mut expected: Expected = BTreeMap::new();

    for (document_id, what) in [
        (String::new(), "an empty id"),
        (
            "x".repeat(MAX_DOC_ID_UTF16_UNITS + 1),
            "an id past 512 units",
        ),
        ("null\0byte".to_string(), "an id with a null byte"),
    ] {
        assert_refused(
            node.insert(INDEX, titled("refused"), Some(&document_id))
                .await,
            VALIDATION_FAILED,
            what,
        );
        assert_refused(
            node.update(INDEX, &document_id, titled("refused")).await,
            VALIDATION_FAILED,
            what,
        );
        assert_refused(
            node.remove(INDEX, &document_id).await,
            VALIDATION_FAILED,
            what,
        );
    }
    assert_refused(
        node.insert(INDEX, with_id("embedded", "refused"), Some("named"))
            .await,
        VALIDATION_FAILED,
        "an id that contradicts the document's own id",
    );
    let mut malformed = Map::new();
    malformed.insert("title", Value::from(42.0));
    assert_refused(
        node.insert(INDEX, malformed, Some("a-number-for-a-title"))
            .await,
        VALIDATION_FAILED,
        "a title that the schema declares a string",
    );
    expected.insert("a-number-for-a-title".to_string(), None);
    assert_refused(
        node.insert("no-such-index", titled("refused"), Some("anywhere"))
            .await,
        "INDEX_NOT_FOUND",
        "an index that the cluster does not hold",
    );
    let stored = node
        .insert(INDEX, titled("kept"), Some("anywhere"))
        .await
        .expect("the primary takes the insert");
    assert_eq!(stored, "anywhere");
    expected.insert("anywhere".to_string(), Some("kept".to_string()));
    assert_refused(
        node.insert(
            "narsil-generation-hidden",
            titled("refused"),
            Some("hidden"),
        )
        .await,
        "CONFIG_INVALID",
        "a name reserved for partition count changes",
    );
    assert_refused(
        node.update(INDEX, "never-written", titled("refused")).await,
        "DOC_NOT_FOUND",
        "an update of a document that the index never held",
    );
    assert_refused(
        node.insert(INDEX, titled("again"), Some("anywhere")).await,
        "DOC_ALREADY_EXISTS",
        "a second insert of one id",
    );

    let mut batch = vec![
        with_id("batch-first", "first"),
        with_id("batch-second", "second"),
    ];
    let mut number_title = Map::new();
    number_title.insert("id", Value::from("batch-number"));
    number_title.insert("title", Value::from(7.0));
    batch.push(number_title);
    batch.push(with_id(&"y".repeat(MAX_DOC_ID_UTF16_UNITS + 1), "too long"));
    batch.push(with_id("batch-first", "a repeat inside the batch"));
    batch.push(with_id("batch-third", "third"));
    let outcome = node
        .insert_batch(INDEX, batch)
        .await
        .expect("the batch is routed");
    assert_eq!(
        outcome.succeeded,
        ["batch-first", "batch-second", "batch-third"],
        "{:?}",
        outcome.failed
    );
    let failed: Vec<(&str, &str)> = outcome
        .failed
        .iter()
        .map(|failure| (failure.document_id.as_str(), failure.error.code()))
        .collect();
    let long_id = "y".repeat(MAX_DOC_ID_UTF16_UNITS + 1);
    assert_eq!(
        failed,
        [
            ("batch-number", VALIDATION_FAILED),
            (long_id.as_str(), VALIDATION_FAILED),
            ("batch-first", "DOC_ALREADY_EXISTS"),
        ]
    );
    for (document_id, title) in [
        ("batch-first", "first"),
        ("batch-second", "second"),
        ("batch-third", "third"),
    ] {
        expected.insert(document_id.to_string(), Some(title.to_string()));
    }
    expected.insert("batch-number".to_string(), None);

    let from_a_primary: Vec<Map> = (0..200)
        .map(|serial| {
            with_id(
                &format!("through-a-data-node-{serial}"),
                &format!("local {serial}"),
            )
        })
        .collect();
    let applied = data[0]
        .node
        .insert_batch(INDEX, from_a_primary)
        .await
        .expect("the batch is routed");
    assert!(applied.failed.is_empty(), "{:?}", applied.failed.first());
    for serial in 0..200 {
        expected.insert(
            format!("through-a-data-node-{serial}"),
            Some(format!("local {serial}")),
        );
    }
    let removals: Vec<String> = (0..50)
        .map(|serial| format!("through-a-data-node-{serial}"))
        .collect();
    let removed = data[1]
        .node
        .remove_batch(INDEX, removals.clone())
        .await
        .expect("the batch is routed");
    assert!(removed.failed.is_empty(), "{:?}", removed.failed.first());
    for document_id in removals {
        expected.insert(document_id, None);
    }

    let primary_address = &data[0].address;
    let raw = forwarder();
    let answer = raw
        .send(
            primary_address,
            TransportMessage::new(
                FORWARD_BATCH,
                FORWARDER,
                "past-the-limit",
                oversized_batch(SPEC_BATCH_LIMIT + 1),
            ),
        )
        .await
        .expect("the primary answers");
    let decoded = decode(&answer.payload);
    assert!(answer.message_type.ends_with(".error"), "{decoded:?}");
    assert_eq!(decoded.text("code"), "REPLICATION_ENTRY_INVALID");
    expected.insert("past-the-limit-0".to_string(), None);
    raw.shutdown().await;

    let data_refs: Vec<&DataNode> = data.iter().collect();
    let difference = copy_difference(&data_refs, INDEX, &holders, &expected).await;
    assert!(
        difference.is_none(),
        "each copy holds exactly the documents that hash to its partitions: {difference:?}"
    );

    router.node.shutdown().await;
    assert_refused(
        router
            .node
            .insert(INDEX, titled("late"), Some("late"))
            .await,
        "NODE_NOT_JOINED",
        "a write after the node shut down",
    );
    router.transport.shutdown().await;
    for node in data {
        node.stop().await;
    }
    controller.stop().await;
    coordinator.shutdown().await;
}

const ROUTED: &str = "routed-ledger";
const ROUTED_UUID: &str = "uuid-of-the-routed-ledger";
const ROUTER: &str = "routed-ledger-router";
const SCRIPTED: &str = "scripted-primary";
const FORWARD: &str = "replication.forward";
const QUERY_FETCH: &str = "query.fetch";
const QUERY_FETCH_RESULT: &str = "query.fetch_result";
const OUTCOME_UNKNOWN: &str = "REPLICATION_OUTCOME_UNKNOWN";
const TERM_ENDED: &str = "term_ended";
const FORWARD_WINDOW_ENDED: &str = "forward_window_ended";
const NOT_PRIMARY: &str = "PARTITION_NOT_PRIMARY";
const ALREADY_EXISTS: &str = "DOC_ALREADY_EXISTS";
const ROUTING_FAILED: &str = "QUERY_ROUTING_FAILED";
const SPEC_FORWARD_WINDOW: Duration = Duration::from_secs(30);
const LATE_CHUNK_WAIT: Duration = Duration::from_secs(3);
const OTHER_PARTITION_WAIT: Duration = Duration::from_secs(10);
const WRITES_PER_PARTITION: usize = 3;
const SENT_VECTOR: [f32; 3] = [0.5, -1.25, 3.0];

type Received = Arc<Mutex<Vec<TransportMessage>>>;
type Answer = BoxFuture<'static, Option<TransportMessage>>;

struct ScriptedPrimary {
    transport: TcpTransport,
    node_id: String,
    received: Received,
}

impl ScriptedPrimary {
    async fn start<F, Fut>(script: F) -> ScriptedPrimary
    where
        F: Fn(TransportMessage) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Option<TransportMessage>> + Send + 'static,
    {
        let transport = TcpTransport::new(
            SCRIPTED,
            TcpTransportConfig {
                host: "127.0.0.1".to_string(),
                port: 0,
                ..TcpTransportConfig::default()
            },
        )
        .expect("the scripted primary's transport settings are valid");
        let received: Received = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&received);
        let handler = listen_handler(move |request: TransportMessage, respond: Respond| {
            log.lock()
                .expect("no recorder panicked")
                .push(request.clone());
            let answer = script(request);
            async move {
                match answer.await {
                    Some(reply) => respond.send(reply).await,
                    None => std::future::pending::<()>().await,
                }
                Ok(())
            }
        });
        transport
            .listen(handler)
            .await
            .expect("the scripted primary listens");
        let node_id = format!("127.0.0.1:{}", transport.port());
        ScriptedPrimary {
            transport,
            node_id,
            received,
        }
    }

    fn received(&self, message_type: &str) -> Vec<TransportMessage> {
        self.received
            .lock()
            .expect("no recorder panicked")
            .iter()
            .filter(|request| request.message_type == message_type)
            .cloned()
            .collect()
    }
}

fn led_by(primary: &str, primary_term: u64) -> Map {
    let mut assignment = Map::new();
    assignment.insert("primary", Value::from(primary));
    assignment.insert("replicas", Value::Array(Vec::new()));
    assignment.insert("inSyncSet", Value::Array(Vec::new()));
    assignment.insert("commitPoint", Value::from(0.0));
    assignment.insert("state", Value::from("ACTIVE"));
    assignment.insert("primaryTerm", Value::from(primary_term as f64));
    assignment
}

async fn store_routed_table(
    coordinator: &EtcdCoordinator,
    version: f64,
    primaries: &[(&str, u64)],
) {
    let table = AllocationTable {
        index_name: ROUTED.to_string(),
        version,
        replication_factor: 0.0,
        assignments: primaries
            .iter()
            .enumerate()
            .map(|(partition_id, (primary, term))| (partition_id as f64, led_by(primary, *term)))
            .collect(),
        generation: None,
        index_uuid: Some(ROUTED_UUID.to_string()),
    };
    coordinator
        .put_allocation(ROUTED, &table)
        .await
        .expect("etcd takes the table");
}

fn reply(request: &TransportMessage, message_type: &str, payload: Vec<u8>) -> TransportMessage {
    TransportMessage::new(message_type, SCRIPTED, request.request_id.as_str(), payload)
}

fn refusal(request: &TransportMessage, code: &str, reason: Option<&str>) -> TransportMessage {
    let mut out = Vec::new();
    write_map_header(&mut out, 3 + usize::from(reason.is_some()));
    write_text(&mut out, "error");
    out.push(0xc3);
    write_text(&mut out, "code");
    write_text(&mut out, code);
    write_text(&mut out, "message");
    write_text(&mut out, "The scripted primary refused the write");
    if let Some(reason) = reason {
        write_text(&mut out, "details");
        write_map_header(&mut out, 1);
        write_text(&mut out, "reason");
        write_text(&mut out, reason);
    }
    reply(request, &format!("{}.error", request.message_type), out)
}

fn write_short_array_header(out: &mut Vec<u8>, count: usize) {
    assert!(count < 16, "the scripted primary answers short arrays only");
    out.push(0x90 | count as u8);
}

fn operation_ids(request: &TransportMessage) -> Vec<String> {
    match decode(&request.payload).field("operations") {
        Some(Decoded::List(operations)) => operations
            .iter()
            .map(|operation| operation.text("documentId"))
            .collect(),
        other => panic!("a forwarded batch holds no operations: {other:?}"),
    }
}

fn batch_answer(request: &TransportMessage, refused_with: Option<&str>) -> TransportMessage {
    let operations = operation_ids(request);
    let mut out = Vec::new();
    write_map_header(&mut out, 1);
    write_text(&mut out, "results");
    write_short_array_header(&mut out, operations.len());
    for document_id in operations {
        match refused_with {
            None => {
                write_map_header(&mut out, 2);
                write_text(&mut out, "documentId");
                write_text(&mut out, &document_id);
                write_text(&mut out, "success");
                out.push(0xc3);
            }
            Some(code) => {
                write_map_header(&mut out, 4);
                write_text(&mut out, "documentId");
                write_text(&mut out, &document_id);
                write_text(&mut out, "success");
                out.push(0xc2);
                write_text(&mut out, "errorCode");
                write_text(&mut out, code);
                write_text(&mut out, "errorMessage");
                write_text(&mut out, "The scripted primary refused the operation");
            }
        }
    }
    reply(request, FORWARD_BATCH, out)
}

fn little_endian_float32(values: &[f32]) -> Vec<u8> {
    values
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

fn fetch_answer(request: &TransportMessage, document_id: &str, title: &str) -> TransportMessage {
    let mut out = Vec::new();
    write_map_header(&mut out, 1);
    write_text(&mut out, "documents");
    write_short_array_header(&mut out, 1);
    write_map_header(&mut out, 2);
    write_text(&mut out, "docId");
    write_text(&mut out, document_id);
    write_text(&mut out, "document");
    write_map_header(&mut out, 2);
    write_text(&mut out, "title");
    write_text(&mut out, title);
    write_text(&mut out, "embedding");
    write_binary(&mut out, &little_endian_float32(&SENT_VECTOR));
    reply(request, QUERY_FETCH_RESULT, out)
}

fn hands_over_with_an_ended_term(
    coordinator: &Arc<EtcdCoordinator>,
    successor: &str,
) -> impl Fn(TransportMessage) -> Answer + Send + Sync + 'static {
    let coordinator = Arc::clone(coordinator);
    let successor = successor.to_string();
    move |request| -> Answer {
        let coordinator = Arc::clone(&coordinator);
        let successor = successor.clone();
        Box::pin(async move {
            store_routed_table(&coordinator, 2.0, &[(&successor, 2)]).await;
            Some(refusal(&request, OUTCOME_UNKNOWN, Some(TERM_ENDED)))
        })
    }
}

fn reason_of(error: &ClusterError) -> Option<&str> {
    error.details().get("reason").and_then(Value::as_str)
}

async fn start_router(coordinator: &Arc<EtcdCoordinator>, scratch: &Scratch) -> DataNode {
    DataNode::start_with_roles(coordinator, ROUTER, scratch.path(), &["coordinator"]).await
}

async fn stop_routing(
    router: DataNode,
    primaries: Vec<ScriptedPrimary>,
    coordinator: Arc<EtcdCoordinator>,
) {
    router.stop().await;
    for primary in primaries {
        primary.transport.shutdown().await;
    }
    coordinator.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_write_whose_term_ended_answers_that_refusal_when_the_next_primary_refuses_it_as_not_primary()
 {
    let Some(coordinator) = cluster_coordinator().await else {
        return;
    };
    create_cluster_index(&coordinator, ROUTED, ROUTED_UUID, 1, 0).await;
    let forgetting = Arc::clone(&coordinator);
    let successor = ScriptedPrimary::start(move |request| {
        let coordinator = Arc::clone(&forgetting);
        async move {
            coordinator
                .delete_allocation(ROUTED)
                .await
                .expect("etcd drops the table");
            Some(refusal(&request, NOT_PRIMARY, None))
        }
    })
    .await;
    let first = ScriptedPrimary::start(hands_over_with_an_ended_term(
        &coordinator,
        &successor.node_id,
    ))
    .await;
    store_routed_table(&coordinator, 1.0, &[(&first.node_id, 1)]).await;
    let scratch = Scratch::new();
    let router = start_router(&coordinator, &scratch).await;

    let error = router
        .node
        .insert(ROUTED, titled("may be stored"), Some("contested"))
        .await
        .expect_err("no attempt of the write succeeded");

    assert_eq!(error.code(), OUTCOME_UNKNOWN, "{error:?}");
    assert_eq!(reason_of(&error), Some(TERM_ENDED), "{error:?}");
    assert_eq!(first.received(FORWARD).len(), 1);
    assert_eq!(successor.received(FORWARD).len(), 1);
    stop_routing(router, vec![first, successor], coordinator).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_insert_with_a_vector_settles_against_the_copy_that_a_later_primary_returns_as_bytes() {
    let Some(coordinator) = cluster_coordinator().await else {
        return;
    };
    create_cluster_index(&coordinator, ROUTED, ROUTED_UUID, 1, 0).await;
    let document_id = "embedded";
    let title = "stored by the first attempt";
    let successor = ScriptedPrimary::start(move |request| async move {
        if request.message_type == QUERY_FETCH {
            Some(fetch_answer(&request, document_id, title))
        } else {
            Some(refusal(&request, ALREADY_EXISTS, None))
        }
    })
    .await;
    let first = ScriptedPrimary::start(hands_over_with_an_ended_term(
        &coordinator,
        &successor.node_id,
    ))
    .await;
    store_routed_table(&coordinator, 1.0, &[(&first.node_id, 1)]).await;
    let scratch = Scratch::new();
    let router = start_router(&coordinator, &scratch).await;
    let mut document = titled(title);
    document.insert(
        "embedding",
        Value::Array(
            SENT_VECTOR
                .iter()
                .map(|value| Value::from(f64::from(*value)))
                .collect(),
        ),
    );

    let stored = router
        .node
        .insert(ROUTED, document, Some(document_id))
        .await
        .expect("the later primary holds exactly the document that the insert sent");

    assert_eq!(stored, document_id);
    let fetches = successor.received(QUERY_FETCH);
    let [fetch] = fetches.as_slice() else {
        panic!("the router reads the later primary's copy once: {fetches:?}");
    };
    let requested = decode(&fetch.payload);
    let Some(Decoded::List(named)) = requested.field("documentIds") else {
        panic!("the fetch names its documents: {requested:?}");
    };
    assert_eq!(
        named
            .iter()
            .map(|entry| entry.text("docId"))
            .collect::<Vec<_>>(),
        [document_id]
    );
    stop_routing(router, vec![first, successor], coordinator).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_batch_whose_window_closes_sends_no_chunk_that_it_has_yet_to_send() {
    let Some(coordinator) = cluster_coordinator().await else {
        return;
    };
    create_cluster_index(&coordinator, ROUTED, ROUTED_UUID, 1, 0).await;
    let silent = ScriptedPrimary::start(|_| async { None }).await;
    store_routed_table(&coordinator, 1.0, &[(&silent.node_id, 1)]).await;
    let scratch = Scratch::new();
    let router = start_router(&coordinator, &scratch).await;
    let documents: Vec<Map> = (0..=SPEC_BATCH_LIMIT)
        .map(|serial| with_id(&format!("unanswered-{serial}"), "never answered"))
        .collect();

    let started = tokio::time::Instant::now();
    let outcome = router
        .node
        .insert_batch(ROUTED, documents)
        .await
        .expect("the batch is routed");

    assert!(started.elapsed() >= SPEC_FORWARD_WINDOW);
    assert!(outcome.succeeded.is_empty(), "{:?}", outcome.succeeded);
    assert_eq!(outcome.failed.len(), SPEC_BATCH_LIMIT + 1);
    for failure in &outcome.failed {
        assert_eq!(failure.error.code(), OUTCOME_UNKNOWN, "{failure:?}");
        assert_eq!(
            reason_of(&failure.error),
            Some(FORWARD_WINDOW_ENDED),
            "{failure:?}"
        );
    }
    tokio::time::sleep(LATE_CHUNK_WAIT).await;
    let batches = silent.received(FORWARD_BATCH);
    assert_eq!(
        batches.len(),
        1,
        "the router sends the second chunk after the client holds its answer"
    );
    assert_eq!(operation_ids(&batches[0]).len(), SPEC_BATCH_LIMIT);
    stop_routing(router, vec![silent], coordinator).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_partition_that_loses_its_table_fails_only_its_own_writes_in_a_batch() {
    let Some(coordinator) = cluster_coordinator().await else {
        return;
    };
    create_cluster_index(&coordinator, ROUTED, ROUTED_UUID, 2, 0).await;
    let reached = Arc::new(Notify::new());
    let reached_by_batch = Arc::clone(&reached);
    let answering = ScriptedPrimary::start(move |request| {
        let reached = Arc::clone(&reached_by_batch);
        async move {
            reached.notify_one();
            Some(batch_answer(&request, None))
        }
    })
    .await;
    let emptying = Arc::clone(&coordinator);
    let refusing = ScriptedPrimary::start(move |request| {
        let coordinator = Arc::clone(&emptying);
        let reached = Arc::clone(&reached);
        async move {
            tokio::time::timeout(OTHER_PARTITION_WAIT, reached.notified())
                .await
                .expect("the other partition's batch reaches its primary");
            store_routed_table(&coordinator, 2.0, &[]).await;
            Some(batch_answer(&request, Some(NOT_PRIMARY)))
        }
    })
    .await;
    store_routed_table(
        &coordinator,
        1.0,
        &[(&answering.node_id, 1), (&refusing.node_id, 1)],
    )
    .await;
    let scratch = Scratch::new();
    let router = start_router(&coordinator, &scratch).await;
    let mut kept = Vec::new();
    let mut lost = Vec::new();
    let mut documents = Vec::new();
    for serial in 0.. {
        if kept.len() == WRITES_PER_PARTITION && lost.len() == WRITES_PER_PARTITION {
            break;
        }
        let document_id = format!("order-{serial}");
        let partition = if fnv1a_partition(&document_id, 2) == 0 {
            &mut kept
        } else {
            &mut lost
        };
        if partition.len() < WRITES_PER_PARTITION {
            partition.push(document_id.clone());
            documents.push(with_id(&document_id, "split across partitions"));
        }
    }

    let outcome = router
        .node
        .insert_batch(ROUTED, documents)
        .await
        .expect("the batch answers each write");

    assert_eq!(outcome.succeeded, kept, "{:?}", outcome.failed);
    let failed: Vec<(&str, &str)> = outcome
        .failed
        .iter()
        .map(|failure| (failure.document_id.as_str(), failure.error.code()))
        .collect();
    let expected: Vec<(&str, &str)> = lost
        .iter()
        .map(|id| (id.as_str(), ROUTING_FAILED))
        .collect();
    assert_eq!(failed, expected);
    let applied: Vec<String> = answering
        .received(FORWARD_BATCH)
        .iter()
        .flat_map(operation_ids)
        .collect();
    assert_eq!(applied, kept);
    stop_routing(router, vec![answering, refusing], coordinator).await;
}
