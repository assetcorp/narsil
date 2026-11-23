use narsil::{Map, Value};
use narsil_cluster::coordinator::etcd::EtcdCoordinatorConfig;

use crate::data_node::{DataNode, Scratch, coordinator_at, etcd_endpoint, unique_key_prefix};
use crate::ledger::start_controller;
use crate::spread::{fnv1a_partition, settled_holders};
use crate::typescript_node::{TypescriptNode, fields};

const INDEX: &str = "mixed-catalogue";
const PARTITIONS: u32 = 2;
const REPLICATION_FACTOR: u64 = 1;
const STORED_ITEMS: u64 = 6;
const KEEP_ALIVE_MS: u64 = 60_000;
const DATA_NODE: &str = "contexts-rust-data";
const REPLICA_NODE: &str = "contexts-rust-replica";

fn item_id(rank: u64) -> String {
    format!("item-{rank}")
}

fn item(rank: u64, note: &str) -> Value {
    Value::Object(fields([
        ("title", Value::from(format!("widget {rank}"))),
        ("note", Value::from(note)),
    ]))
}

async fn send(node: &mut TypescriptNode, target: &str, message_type: &str, payload: Map) -> Map {
    let answer = node
        .call(
            "send",
            fields([
                ("target", Value::from(target)),
                ("messageType", Value::from(message_type)),
                ("payload", Value::Object(payload)),
            ]),
        )
        .await
        .value();
    answer
        .as_object()
        .and_then(|reply| reply.get("payload"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(|| {
            panic!("the data node answers {message_type} with an object: {answer:?}")
        })
}

fn fetch_payload(context_id: Option<&str>, document_id: &str) -> Map {
    let reference = Value::Object(fields([
        ("docId", Value::from(document_id)),
        (
            "partitionId",
            Value::from(fnv1a_partition(document_id, PARTITIONS)),
        ),
    ]));
    fields([
        ("indexName", Value::from(INDEX)),
        ("documentIds", Value::Array(vec![reference])),
        ("fields", Value::Null),
        ("highlight", Value::Null),
        ("contextId", context_id.map_or(Value::Null, Value::from)),
        ("releaseContext", Value::Bool(false)),
    ])
}

fn fetched_note(answer: &Map) -> Option<String> {
    let documents = answer
        .get("documents")
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("the fetch answer lists its documents: {answer:?}"));
    assert_eq!(documents.len(), 1, "{answer:?}");
    documents[0]
        .as_object()
        .and_then(|fetched| fetched.get("document"))
        .and_then(Value::as_object)
        .and_then(|document| document.get("note"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_data_node_returns_the_document_as_it_ranked_it_after_a_write_changes_it() {
    let Some(endpoint) = etcd_endpoint() else {
        return;
    };
    let key_prefix = unique_key_prefix();
    let ttl = EtcdCoordinatorConfig::default().node_heartbeat_ttl_seconds;
    let coordinator = coordinator_at(endpoint.clone(), key_prefix.clone(), ttl).await;
    let controller_scratch = Scratch::new();
    let controller = start_controller(&coordinator, &controller_scratch).await;
    let scratches = [Scratch::new(), Scratch::new()];
    let mut data_nodes = Vec::new();
    for (node_id, scratch) in [DATA_NODE, REPLICA_NODE].into_iter().zip(&scratches) {
        data_nodes.push(DataNode::start(&coordinator, node_id, scratch.path()).await);
    }
    let mut reader =
        TypescriptNode::start(&endpoint, &key_prefix, "contexts-ts-reader", "coordinator").await;
    let schema = Value::Object(fields([
        ("title", Value::from("string")),
        ("note", Value::from("string")),
    ]));
    reader
        .create_index_with_schema(
            INDEX,
            u64::from(PARTITIONS),
            REPLICATION_FACTOR,
            schema,
            Map::new(),
        )
        .await;
    settled_holders(&coordinator, INDEX, PARTITIONS).await;
    for rank in 0..STORED_ITEMS {
        reader
            .call(
                "insert",
                fields([
                    ("indexName", Value::from(INDEX)),
                    ("documentId", Value::from(item_id(rank))),
                    ("document", item(rank, &format!("original {rank}"))),
                ]),
            )
            .await
            .value();
    }

    let params = Value::Object(fields([
        ("term", Value::from("widget")),
        ("limit", Value::from(STORED_ITEMS)),
        ("offset", Value::from(0u64)),
        ("scoring", Value::from("local")),
    ]));
    let partition_ids = (0..PARTITIONS).map(Value::from).collect();
    let target = data_nodes[0].address.clone();
    let searched = send(
        &mut reader,
        &target,
        "query.search",
        fields([
            ("indexName", Value::from(INDEX)),
            ("partitionIds", Value::Array(partition_ids)),
            ("params", params),
            ("globalStats", Value::Null),
            ("facetShardSize", Value::Null),
            ("keepAliveMs", Value::from(KEEP_ALIVE_MS)),
        ]),
    )
    .await;
    let context_id = searched
        .get("contextId")
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("a search with a keep-alive opens a context: {searched:?}"))
        .to_string();

    let rewritten = item_id(0);
    reader
        .call(
            "update",
            fields([
                ("indexName", Value::from(INDEX)),
                ("documentId", Value::from(rewritten.as_str())),
                ("document", item(0, "rewritten")),
            ]),
        )
        .await
        .value();

    let current = send(
        &mut reader,
        &target,
        "query.fetch",
        fetch_payload(None, &rewritten),
    )
    .await;
    assert_eq!(fetched_note(&current).as_deref(), Some("rewritten"));
    let ranked = send(
        &mut reader,
        &target,
        "query.fetch",
        fetch_payload(Some(&context_id), &rewritten),
    )
    .await;
    assert_eq!(fetched_note(&ranked).as_deref(), Some("original 0"));

    reader.shutdown().await;
    for node in data_nodes {
        node.stop().await;
    }
    controller.stop().await;
    coordinator.shutdown().await;
}
