use std::time::{Duration, Instant};

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
const RELEASE_WAIT: Duration = Duration::from_secs(10);
const RELEASE_POLL: Duration = Duration::from_millis(50);
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

fn fetch_payload(context_id: Option<&str>, document_id: &str, include: Option<&str>) -> Map {
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
        (
            "fields",
            include.map_or(Value::Null, |field| Value::Array(vec![Value::from(field)])),
        ),
        ("highlight", Value::Null),
        ("contextId", context_id.map_or(Value::Null, Value::from)),
        ("releaseContext", Value::Bool(false)),
    ])
}

fn fetched_document(answer: &Map) -> Map {
    let documents = answer
        .get("documents")
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("the fetch answer lists its documents: {answer:?}"));
    assert_eq!(documents.len(), 1, "{answer:?}");
    documents[0]
        .as_object()
        .and_then(|fetched| fetched.get("document"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(|| panic!("each fetched entry carries its document: {answer:?}"))
}

fn note_of(document: &Map) -> Option<&str> {
    document.get("note").and_then(Value::as_str)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_data_node_returns_the_ranked_copy_and_frees_the_contexts_of_a_coordinator_that_leaves()
 {
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

    let mut departing = TypescriptNode::start(
        &endpoint,
        &key_prefix,
        "contexts-ts-departing",
        "coordinator",
    )
    .await;
    let params = Value::Object(fields([
        ("term", Value::from("widget")),
        ("limit", Value::from(STORED_ITEMS)),
        ("offset", Value::from(0u64)),
        ("scoring", Value::from("local")),
    ]));
    let partition_ids = (0..PARTITIONS).map(Value::from).collect();
    let target = data_nodes[0].address.clone();
    let searched = send(
        &mut departing,
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

    let ranked = send(
        &mut reader,
        &target,
        "query.fetch",
        fetch_payload(Some(&context_id), &rewritten, None),
    )
    .await;
    let ranked = fetched_document(&ranked);
    assert_eq!(note_of(&ranked), Some("original 0"), "{ranked:?}");
    assert_eq!(
        ranked.get("title").and_then(Value::as_str),
        Some("widget 0")
    );

    let projected = send(
        &mut reader,
        &target,
        "query.fetch",
        fetch_payload(Some(&context_id), &rewritten, Some("note")),
    )
    .await;
    let projected = fetched_document(&projected);
    assert_eq!(note_of(&projected), Some("original 0"));
    assert_eq!(projected.get("title"), None, "{projected:?}");

    let current = send(
        &mut reader,
        &target,
        "query.fetch",
        fetch_payload(None, &rewritten, None),
    )
    .await;
    assert_eq!(note_of(&fetched_document(&current)), Some("rewritten"));

    departing.shutdown().await;
    let started = Instant::now();
    let refused = loop {
        let answer = send(
            &mut reader,
            &target,
            "query.fetch",
            fetch_payload(Some(&context_id), &rewritten, None),
        )
        .await;
        if answer.get("code").is_some() || started.elapsed() > RELEASE_WAIT {
            break answer;
        }
        tokio::time::sleep(RELEASE_POLL).await;
    };
    assert_eq!(
        refused.get("code").and_then(Value::as_str),
        Some("SEARCH_CONTEXT_MISSING"),
        "{refused:?}"
    );

    reader.shutdown().await;
    for node in data_nodes {
        node.stop().await;
    }
    controller.stop().await;
    coordinator.shutdown().await;
}
