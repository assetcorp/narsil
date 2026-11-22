use std::collections::BTreeMap;

use narsil::{Map, Value};
use narsil_cluster::coordinator::etcd::EtcdCoordinatorConfig;

use crate::data_node::{DataNode, Scratch, coordinator_at, etcd_endpoint, unique_key_prefix};
use crate::ledger::start_controller;
use crate::spread::{
    Expected, NON_ASCII_IDS, assert_non_ascii_ids_tell_the_encodings_apart, copy_difference,
    expected_counts, fnv1a_partition, settled_holders, titled,
};
use crate::typescript_node::{TypescriptNode, fields, title_document};

const INDEX: &str = "mixed-ledger";
const PARTITIONS: u32 = 3;
const REPLICATION_FACTOR: u64 = 1;
const BEYOND_ONE_MESSAGE: usize = 3_500;
const UUID_TEXT_LENGTH: usize = 36;
const UUID_VERSION_AT: usize = 14;

const VECTOR_DOCUMENT_ID: &str = "from-typescript-with-vector";

fn is_uuid_version_seven(document_id: &str) -> bool {
    document_id.len() == UUID_TEXT_LENGTH && document_id.as_bytes()[UUID_VERSION_AT] == b'7'
}

fn numbers(values: [f64; 3]) -> Value {
    Value::Array(values.into_iter().map(Value::from).collect())
}

async fn forward_vector_write(
    forwarder: &mut TypescriptNode,
    operation: &str,
    title: &str,
    embedding: [f64; 3],
) {
    let document = fields([
        ("title", Value::from(title)),
        ("embedding", numbers(embedding)),
    ]);
    forwarder
        .call(
            operation,
            fields([
                ("indexName", Value::from(INDEX)),
                ("documentId", Value::from(VECTOR_DOCUMENT_ID)),
                ("document", Value::Object(document)),
                ("vectorFields", Value::Array(vec![Value::from("embedding")])),
            ]),
        )
        .await
        .value();
}

async fn held_embedding(nodes: &[DataNode], holders: &BTreeMap<u32, Vec<String>>) -> Value {
    let partition_id = fnv1a_partition(VECTOR_DOCUMENT_ID, PARTITIONS);
    let holder = nodes
        .iter()
        .find(|node| {
            holders[&partition_id]
                .iter()
                .any(|id| id == node.node.node_id())
        })
        .expect("a Rust node holds the vector document's partition");
    let held = holder
        .node
        .local_document(INDEX, VECTOR_DOCUMENT_ID)
        .await
        .expect("the Rust primary reads its copy")
        .expect("the Rust primary holds the vector document");
    held.get("embedding").cloned().unwrap_or(Value::Null)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_typescript_node_forwards_every_write_to_the_rust_primary_of_its_partition() {
    let Some(endpoint) = etcd_endpoint() else {
        return;
    };
    let key_prefix = unique_key_prefix();
    let ttl = EtcdCoordinatorConfig::default().node_heartbeat_ttl_seconds;
    let coordinator = coordinator_at(endpoint.clone(), key_prefix.clone(), ttl).await;
    let controller_scratch = Scratch::new();
    let controller = start_controller(&coordinator, &controller_scratch).await;
    let scratches = [Scratch::new(), Scratch::new(), Scratch::new()];
    let mut nodes = Vec::new();
    for (node_id, scratch) in ["mixed-rust-a", "mixed-rust-b", "mixed-rust-c"]
        .into_iter()
        .zip(&scratches)
    {
        nodes.push(DataNode::start(&coordinator, node_id, scratch.path()).await);
    }
    let mut forwarder = TypescriptNode::start(
        &endpoint,
        &key_prefix,
        "mixed-ts-coordinator",
        "coordinator",
    )
    .await;
    let schema = Value::Object(fields([
        ("title", Value::from("string")),
        ("embedding", Value::from("vector[3]")),
    ]));
    forwarder
        .create_index_with_schema(
            INDEX,
            u64::from(PARTITIONS),
            REPLICATION_FACTOR,
            schema,
            Map::new(),
        )
        .await;
    let holders = settled_holders(&coordinator, INDEX, PARTITIONS).await;

    let mut expected: Expected = BTreeMap::new();
    for serial in 0..24 {
        let document_id = format!("from-typescript-{serial}");
        let title = format!("first title {serial}");
        forwarder.insert(INDEX, &document_id, &title).await.value();
        expected.insert(document_id, Some(title));
    }
    assert_non_ascii_ids_tell_the_encodings_apart(PARTITIONS);
    for (serial, document_id) in NON_ASCII_IDS.into_iter().enumerate() {
        let title = format!("beyond ascii {serial}");
        forwarder.insert(INDEX, document_id, &title).await.value();
        expected.insert(document_id.to_string(), Some(title));
    }
    for serial in 0..8 {
        let document_id = format!("from-typescript-{serial}");
        let title = format!("second title {serial}");
        forwarder.update(INDEX, &document_id, &title).await.value();
        expected.insert(document_id, Some(title));
    }
    for serial in 8..12 {
        let document_id = format!("from-typescript-{serial}");
        forwarder.remove(INDEX, &document_id).await.value();
        expected.insert(document_id, None);
    }
    let generated = forwarder
        .call(
            "insert",
            fields([
                ("indexName", Value::from(INDEX)),
                ("documentId", Value::Null),
                ("document", title_document("a generated id")),
            ]),
        )
        .await
        .value();
    let generated = generated
        .as_str()
        .expect("the TypeScript node returns the id it generated")
        .to_string();
    expected.insert(generated, Some("a generated id".to_string()));
    let duplicate = forwarder
        .insert(INDEX, "from-typescript-0", "a duplicate")
        .await;
    assert_eq!(
        duplicate.code(),
        Some("DOC_ALREADY_EXISTS"),
        "{duplicate:?}"
    );

    let inserted_embedding = [0.5, -1.25, 3.0];
    forward_vector_write(&mut forwarder, "insert", "a vector", inserted_embedding).await;
    assert_eq!(
        held_embedding(&nodes, &holders).await,
        numbers(inserted_embedding)
    );
    let updated_embedding = [2.0, 0.25, -4.0];
    forward_vector_write(&mut forwarder, "update", "a new vector", updated_embedding).await;
    assert_eq!(
        held_embedding(&nodes, &holders).await,
        numbers(updated_embedding)
    );
    expected.insert(
        VECTOR_DOCUMENT_ID.to_string(),
        Some("a new vector".to_string()),
    );

    let node_refs: Vec<&DataNode> = nodes.iter().collect();
    let difference = copy_difference(&node_refs, INDEX, &holders, &expected).await;
    assert!(
        difference.is_none(),
        "each Rust copy holds exactly the documents that hash to its partitions: {difference:?}"
    );

    forwarder.shutdown().await;
    for node in nodes {
        node.stop().await;
    }
    controller.stop().await;
    coordinator.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_node_forwards_every_write_to_the_typescript_primary_of_its_partition() {
    let Some(endpoint) = etcd_endpoint() else {
        return;
    };
    let key_prefix = unique_key_prefix();
    let ttl = EtcdCoordinatorConfig::default().node_heartbeat_ttl_seconds;
    let coordinator = coordinator_at(endpoint.clone(), key_prefix.clone(), ttl).await;
    let mut leader =
        TypescriptNode::start(&endpoint, &key_prefix, "mixed-ts-a", "data,controller").await;
    let mut others = Vec::new();
    for node_id in ["mixed-ts-b", "mixed-ts-c"] {
        others.push(TypescriptNode::start(&endpoint, &key_prefix, node_id, "data").await);
    }
    leader
        .create_index(INDEX, u64::from(PARTITIONS), REPLICATION_FACTOR)
        .await;
    settled_holders(&coordinator, INDEX, PARTITIONS).await;
    let router_scratch = Scratch::new();
    let router = DataNode::start_with_roles(
        &coordinator,
        "mixed-rust-coordinator",
        router_scratch.path(),
        &["coordinator"],
    )
    .await;

    let mut expected: Expected = BTreeMap::new();
    for serial in 0..6 {
        let document_id = format!("from-rust-{serial}");
        let title = format!("single {serial}");
        let stored = router
            .node
            .insert(INDEX, titled(&title), Some(&document_id))
            .await
            .expect("the TypeScript primary takes the insert");
        assert_eq!(stored, document_id);
        expected.insert(document_id, Some(title));
    }
    let generated = router
        .node
        .insert(INDEX, titled("a generated id"), None)
        .await
        .expect("the TypeScript primary takes the insert");
    assert!(is_uuid_version_seven(&generated), "{generated}");
    expected.insert(generated, Some("a generated id".to_string()));

    assert_non_ascii_ids_tell_the_encodings_apart(PARTITIONS);
    for (serial, document_id) in NON_ASCII_IDS.into_iter().enumerate() {
        let before: BTreeMap<u32, u64> = leader.partition_counts(INDEX).await.into_iter().collect();
        let title = format!("beyond ascii {serial}");
        router
            .node
            .insert(INDEX, titled(&title), Some(document_id))
            .await
            .expect("the TypeScript primary takes the insert");
        let mut grown = before;
        *grown
            .entry(fnv1a_partition(document_id, PARTITIONS))
            .or_default() += 1;
        let after: BTreeMap<u32, u64> = leader.partition_counts(INDEX).await.into_iter().collect();
        assert_eq!(
            after, grown,
            "{document_id} reaches the partition of its UTF-8 hash"
        );
        expected.insert(document_id.to_string(), Some(title));
    }

    let batch: Vec<_> = (0..BEYOND_ONE_MESSAGE)
        .map(|serial| {
            let mut document = titled(&format!("batched {serial}"));
            document.insert("id", Value::from(format!("batched-{serial}")));
            document
        })
        .collect();
    let inserted = router
        .node
        .insert_batch(INDEX, batch)
        .await
        .expect("the batch is routed");
    assert!(inserted.failed.is_empty(), "{:?}", inserted.failed.first());
    assert_eq!(inserted.succeeded.len(), BEYOND_ONE_MESSAGE);
    for serial in 0..BEYOND_ONE_MESSAGE {
        expected.insert(
            format!("batched-{serial}"),
            Some(format!("batched {serial}")),
        );
    }

    router
        .node
        .update(INDEX, "from-rust-0", titled("updated alone"))
        .await
        .expect("the TypeScript primary takes the update");
    expected.insert("from-rust-0".to_string(), Some("updated alone".to_string()));
    let updates: Vec<(String, _)> = (0..40)
        .map(|serial| {
            let document_id = format!("batched-{serial}");
            (document_id, titled(&format!("updated {serial}")))
        })
        .collect();
    let updated = router
        .node
        .update_batch(INDEX, updates)
        .await
        .expect("the batch is routed");
    assert!(updated.failed.is_empty(), "{:?}", updated.failed.first());
    for serial in 0..40 {
        expected.insert(
            format!("batched-{serial}"),
            Some(format!("updated {serial}")),
        );
    }
    router
        .node
        .remove(INDEX, "from-rust-1")
        .await
        .expect("the TypeScript primary takes the remove");
    expected.insert("from-rust-1".to_string(), None);
    let removals: Vec<String> = (40..60).map(|serial| format!("batched-{serial}")).collect();
    let removed = router
        .node
        .remove_batch(INDEX, removals.clone())
        .await
        .expect("the batch is routed");
    assert!(removed.failed.is_empty(), "{:?}", removed.failed.first());
    for document_id in removals {
        expected.insert(document_id, None);
    }
    let duplicate = router
        .node
        .insert(INDEX, titled("a duplicate"), Some("from-rust-2"))
        .await
        .expect_err("the TypeScript primary refuses a second insert of one id");
    assert_eq!(duplicate.code(), "DOC_ALREADY_EXISTS", "{duplicate:?}");

    let counts = leader.partition_counts(INDEX).await;
    let counted: BTreeMap<u32, u64> = counts.into_iter().collect();
    assert_eq!(
        counted,
        expected_counts(&expected, PARTITIONS),
        "each TypeScript partition holds the documents that hash to it"
    );
    for (document_id, title) in &expected {
        let held = leader.title(INDEX, document_id).await;
        assert_eq!(
            &held,
            title,
            "{document_id} of partition {}",
            fnv1a_partition(document_id, PARTITIONS)
        );
    }

    router.stop().await;
    for node in others {
        node.shutdown().await;
    }
    leader.shutdown().await;
    coordinator.shutdown().await;
}
