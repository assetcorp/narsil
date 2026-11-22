use std::sync::Arc;

use narsil::{Map, Value};
use narsil_cluster::coordinator::etcd::EtcdCoordinator;
use narsil_cluster::message::TransportMessage;
use narsil_cluster::transport::NodeTransport;
use narsil_cluster::transport::tcp::{TcpTransport, TcpTransportConfig};

mod data_node;
mod support;

use data_node::{
    DataNode, Scratch, cluster_coordinator, eventually, is_served_by, metadata_key, metadata_record,
};
use support::{Decoded, decode, write_binary, write_map_header, write_text, write_unsigned};

const NODE_ID: &str = "primary-a";
const RUST_FORWARDER: &str = "rust-test-forwarder";
const ORDERS: &str = "orders";
const ORDERS_UUID: &str = "uuid-of-orders";
const PARTITIONS: u64 = 3;
const FORWARD: &str = "replication.forward";
const FORWARD_BATCH: &str = "replication.forward_batch";
const FORWARD_REFUSED: &str = "replication.forward.error";
const MAX_BATCH_OPERATIONS: usize = 1_000;

struct Operation<'a> {
    document_id: &'a str,
    kind: &'a str,
    document: Option<&'a [(&'a str, &'a str)]>,
    update_fields: Option<&'a [(&'a str, &'a str)]>,
    condition: Option<[u64; 5]>,
}

impl<'a> Operation<'a> {
    fn insert(document_id: &'a str, document: &'a [(&'a str, &'a str)]) -> Operation<'a> {
        Operation {
            document_id,
            kind: "insert",
            document: Some(document),
            update_fields: None,
            condition: None,
        }
    }

    fn merge(document_id: &'a str, fields: &'a [(&'a str, &'a str)]) -> Operation<'a> {
        Operation {
            document_id,
            kind: "update",
            document: None,
            update_fields: Some(fields),
            condition: None,
        }
    }

    fn remove(document_id: &'a str) -> Operation<'a> {
        Operation {
            document_id,
            kind: "remove",
            document: None,
            update_fields: None,
            condition: None,
        }
    }
}

fn write_array_header(out: &mut Vec<u8>, count: usize) {
    if count < 16 {
        out.push(0x90 | count as u8);
    } else {
        out.push(0xdc);
        out.extend_from_slice(&(count as u16).to_be_bytes());
    }
}

fn text_map(fields: &[(&str, &str)]) -> Vec<u8> {
    let mut out = Vec::new();
    write_map_header(&mut out, fields.len());
    for (name, value) in fields {
        write_text(&mut out, name);
        write_text(&mut out, value);
    }
    out
}

const CONDITION_FIELDS: [&str; 5] = [
    "ifSeqNo",
    "ifPrimaryTerm",
    "abandonedSeqNo",
    "abandonedPrimaryTerm",
    "compensationSeqNo",
];

fn operation_fields(out: &mut Vec<u8>, operation: &Operation<'_>) -> usize {
    write_text(out, "documentId");
    write_text(out, operation.document_id);
    write_text(out, "operation");
    write_text(out, operation.kind);
    let mut written = 2;
    if let Some(document) = operation.document {
        write_text(out, "document");
        write_binary(out, &text_map(document));
        written += 1;
    }
    if let Some(fields) = operation.update_fields {
        write_text(out, "updateFields");
        out.extend_from_slice(&text_map(fields));
        written += 1;
    }
    if let Some(condition) = operation.condition {
        for (name, number) in CONDITION_FIELDS.iter().zip(condition) {
            write_text(out, name);
            write_unsigned(out, number);
        }
        written += CONDITION_FIELDS.len();
    }
    written
}

fn counted_map(fields: impl FnOnce(&mut Vec<u8>) -> usize) -> Vec<u8> {
    let mut body = Vec::new();
    let count = fields(&mut body);
    let mut out = Vec::with_capacity(body.len() + 1);
    write_map_header(&mut out, count);
    out.extend_from_slice(&body);
    out
}

fn forward_payload(index: &str, uuid: Option<&str>, operation: &Operation<'_>) -> Vec<u8> {
    counted_map(|out| {
        write_text(out, "indexName");
        write_text(out, index);
        let mut count = 1 + operation_fields(out, operation);
        if let Some(uuid) = uuid {
            write_text(out, "indexUuid");
            write_text(out, uuid);
            count += 1;
        }
        count
    })
}

fn batch_payload(index: &str, uuid: Option<&str>, operations: &[Operation<'_>]) -> Vec<u8> {
    counted_map(|out| {
        write_text(out, "indexName");
        write_text(out, index);
        write_text(out, "operations");
        write_array_header(out, operations.len());
        for operation in operations {
            out.extend_from_slice(&counted_map(|fields| operation_fields(fields, operation)));
        }
        if let Some(uuid) = uuid {
            write_text(out, "indexUuid");
            write_text(out, uuid);
            return 3;
        }
        2
    })
}

struct Forwarder {
    transport: TcpTransport,
    target: String,
}

impl Forwarder {
    async fn send(
        &self,
        message_type: &str,
        request_id: &str,
        payload: Vec<u8>,
    ) -> (String, Decoded) {
        let answer = self
            .transport
            .send(
                &self.target,
                TransportMessage::new(message_type, RUST_FORWARDER, request_id, payload),
            )
            .await
            .expect("the primary answers the forward");
        assert_eq!(answer.request_id, request_id);
        assert_eq!(answer.source_id, NODE_ID);
        (answer.message_type, decode(&answer.payload))
    }

    async fn forward(&self, request_id: &str, operation: &Operation<'_>) -> (String, Decoded) {
        let payload = forward_payload(ORDERS, Some(ORDERS_UUID), operation);
        self.send(FORWARD, request_id, payload).await
    }

    async fn refused(&self, request_id: &str, payload: Vec<u8>) -> String {
        let (message_type, answer) = self.send(FORWARD, request_id, payload).await;
        assert_eq!(
            message_type, FORWARD_REFUSED,
            "{request_id} was accepted: {answer:?}"
        );
        assert_eq!(answer.field("error"), Some(&Decoded::Bool(true)));
        answer.text("code")
    }

    async fn batch(&self, request_id: &str, operations: &[Operation<'_>]) -> Vec<Decoded> {
        let payload = batch_payload(ORDERS, Some(ORDERS_UUID), operations);
        let (message_type, answer) = self.send(FORWARD_BATCH, request_id, payload).await;
        assert_eq!(
            message_type, FORWARD_BATCH,
            "{request_id} was refused whole: {answer:?}"
        );
        match answer.field("results") {
            Some(Decoded::List(results)) => results.clone(),
            other => panic!("{request_id} answered no results: {other:?}"),
        }
    }
}

fn succeeded(result: &Decoded, document_id: &str) -> bool {
    result.text("documentId") == document_id
        && result.field("success") == Some(&Decoded::Bool(true))
}

fn failed_with(result: &Decoded, document_id: &str) -> String {
    assert_eq!(result.text("documentId"), document_id);
    assert_eq!(
        result.field("success"),
        Some(&Decoded::Bool(false)),
        "{result:?}"
    );
    result.text("errorCode")
}

fn stored(fields: &[(&str, &str)]) -> Map {
    let mut document = Map::new();
    for (name, value) in fields {
        document.insert(*name, Value::from(*value));
    }
    document
}

async fn create_orders(coordinator: &EtcdCoordinator) {
    let record = metadata_record(ORDERS, ORDERS_UUID, PARTITIONS, 0);
    assert!(
        coordinator
            .compare_and_set(&metadata_key(ORDERS), None, &record)
            .await
            .expect("etcd takes the metadata")
    );
    let mut schema = Map::new();
    schema.insert("title", Value::from("string"));
    schema.insert("status", Value::from("string"));
    coordinator
        .put_schema(ORDERS, &Value::Object(schema))
        .await
        .expect("etcd takes the schema");
}

async fn primary_with_forwarder(
    coordinator: &Arc<EtcdCoordinator>,
    scratch: &Scratch,
) -> (DataNode, Forwarder) {
    let data = DataNode::start_with_roles(
        coordinator,
        NODE_ID,
        scratch.path(),
        &["data", "controller"],
    )
    .await;
    create_orders(coordinator).await;
    eventually("every partition of the orders index is active", || {
        is_served_by(
            coordinator,
            ORDERS,
            ORDERS_UUID,
            PARTITIONS as usize,
            NODE_ID,
        )
    })
    .await;
    let transport = TcpTransport::new(
        RUST_FORWARDER,
        TcpTransportConfig {
            host: "127.0.0.1".to_string(),
            port: 0,
            ..TcpTransportConfig::default()
        },
    )
    .expect("the forwarder's transport settings are valid");
    let forwarder = Forwarder {
        transport,
        target: data.address.clone(),
    };
    (data, forwarder)
}

async fn held(data: &DataNode, document_id: &str) -> Option<Map> {
    data.node
        .local_document(ORDERS, document_id)
        .await
        .expect("the primary reads its copy")
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_primary_applies_forwarded_writes_in_order_and_refuses_what_it_cannot_apply() {
    let Some(coordinator) = cluster_coordinator().await else {
        return;
    };
    let scratch = Scratch::new();
    let (data, forwarder) = primary_with_forwarder(&coordinator, &scratch).await;

    let ids: Vec<String> = (0..12).map(|serial| format!("order-{serial}")).collect();
    for id in &ids {
        let title = [("title", id.as_str())];
        let (message_type, answer) = forwarder.forward(id, &Operation::insert(id, &title)).await;
        assert_eq!(message_type, FORWARD, "{id}: {answer:?}");
        assert_eq!(answer.text("documentId"), *id);
        assert_eq!(answer.field("success"), Some(&Decoded::Bool(true)));
    }
    for id in &ids {
        assert_eq!(
            held(&data, id).await,
            Some(stored(&[("title", id.as_str())]))
        );
    }

    let again = [("title", "a second order under the same id")];
    let payload = forward_payload(
        ORDERS,
        Some(ORDERS_UUID),
        &Operation::insert("order-0", &again),
    );
    assert_eq!(
        forwarder.refused("duplicate", payload).await,
        "DOC_ALREADY_EXISTS"
    );
    assert_eq!(
        held(&data, "order-0").await,
        Some(stored(&[("title", "order-0")]))
    );

    let packed = [("status", "packed")];
    let (message_type, answer) = forwarder
        .forward("merge", &Operation::merge("order-1", &packed))
        .await;
    assert_eq!(message_type, FORWARD, "{answer:?}");
    assert_eq!(
        held(&data, "order-1").await,
        Some(stored(&[("title", "order-1"), ("status", "packed")]))
    );

    let shipped = [("status", "shipped")];
    let renamed = [("title", "order-2 renamed")];
    let created = [("title", "order-new")];
    let labelled = [("status", "labelled")];
    let results = forwarder
        .batch(
            "ordered-batch",
            &[
                Operation::merge("order-2", &shipped),
                Operation::merge("order-2", &renamed),
                Operation::remove("order-3"),
                Operation::remove("order-3"),
                Operation::insert("order-new", &created),
                Operation::merge("order-new", &labelled),
                Operation::merge("order-missing", &labelled),
            ],
        )
        .await;
    assert_eq!(results.len(), 7);
    for (result, id) in results.iter().zip(["order-2", "order-2", "order-3"]) {
        assert!(succeeded(result, id), "{result:?}");
    }
    assert_eq!(failed_with(&results[3], "order-3"), "DOC_NOT_FOUND");
    assert!(succeeded(&results[4], "order-new"), "{:?}", results[4]);
    assert!(succeeded(&results[5], "order-new"), "{:?}", results[5]);
    assert_eq!(failed_with(&results[6], "order-missing"), "DOC_NOT_FOUND");
    assert_eq!(
        held(&data, "order-2").await,
        Some(stored(&[
            ("title", "order-2 renamed"),
            ("status", "shipped")
        ]))
    );
    assert_eq!(held(&data, "order-3").await, None);
    assert_eq!(
        held(&data, "order-new").await,
        Some(stored(&[("title", "order-new"), ("status", "labelled")]))
    );
    assert_eq!(held(&data, "order-missing").await, None);

    let other_index = forward_payload(
        ORDERS,
        Some("uuid-of-another-index"),
        &Operation::remove("order-4"),
    );
    assert_eq!(
        forwarder.refused("another-index", other_index).await,
        "PARTITION_NOT_PRIMARY"
    );
    assert!(held(&data, "order-4").await.is_some());

    let unknown = forward_payload("no-such-index", None, &Operation::remove("order-4"));
    assert_eq!(
        forwarder.refused("unknown-index", unknown).await,
        "QUERY_ROUTING_FAILED"
    );

    let title = [("title", "conditional")];
    let mut conditional_insert = Operation::insert("order-conditional", &title);
    conditional_insert.condition = Some([1, 1, 2, 1, 3]);
    let payload = forward_payload(ORDERS, Some(ORDERS_UUID), &conditional_insert);
    assert_eq!(
        forwarder.refused("conditional-insert", payload).await,
        "REPLICATION_ENTRY_INVALID"
    );
    assert_eq!(held(&data, "order-conditional").await, None);

    let garbled = vec![
        0x81, 0xa9, b'i', b'n', b'd', b'e', b'x', b'N', b'a', b'm', b'e', 0xc1,
    ];
    assert_eq!(
        forwarder.refused("garbled", garbled).await,
        "TRANSPORT_DECODE_FAILED"
    );

    let not_a_document = {
        let mut payload = forward_payload(ORDERS, Some(ORDERS_UUID), &Operation::remove("order-5"));
        payload[0] += 1;
        write_text(&mut payload, "document");
        write_binary(&mut payload, &[0x93, 0x01, 0x02, 0x03]);
        payload
    };
    let (message_type, answer) = forwarder
        .send(FORWARD, "remove-with-array", not_a_document)
        .await;
    assert_eq!(
        message_type, FORWARD,
        "a remove ignores its document field: {answer:?}"
    );
    assert_eq!(held(&data, "order-5").await, None);

    let array_document = {
        let mut out = Vec::new();
        write_map_header(&mut out, 4);
        write_text(&mut out, "indexName");
        write_text(&mut out, ORDERS);
        write_text(&mut out, "documentId");
        write_text(&mut out, "order-array");
        write_text(&mut out, "operation");
        write_text(&mut out, "insert");
        write_text(&mut out, "document");
        write_binary(&mut out, &[0x93, 0x01, 0x02, 0x03]);
        out
    };
    assert_eq!(
        forwarder.refused("array-document", array_document).await,
        "DOC_VALIDATION_FAILED"
    );
    assert_eq!(held(&data, "order-array").await, None);

    let removal_ids: Vec<String> = (0..=MAX_BATCH_OPERATIONS)
        .map(|serial| format!("order-{serial}"))
        .collect();
    let removals: Vec<Operation<'_>> = removal_ids.iter().map(|id| Operation::remove(id)).collect();
    let (message_type, answer) = forwarder
        .send(
            FORWARD_BATCH,
            "oversized-batch",
            batch_payload(ORDERS, Some(ORDERS_UUID), &removals),
        )
        .await;
    assert_eq!(
        message_type, "replication.forward_batch.error",
        "{answer:?}"
    );
    assert_eq!(answer.text("code"), "REPLICATION_ENTRY_INVALID");
    assert!(held(&data, "order-6").await.is_some());

    forwarder.transport.shutdown().await;
    data.stop().await;
    coordinator.shutdown().await;
}
