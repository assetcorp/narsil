use std::collections::BTreeMap;

use narsil::{Map, Value};
use narsil_cluster::error::ClusterError;
use narsil_cluster::message::TransportMessage;
use narsil_cluster::transport::NodeTransport;

use crate::data_node::{DataNode, Scratch, cluster_coordinator, create_cluster_index};
use crate::ledger::{FORWARDER, forwarder, start_controller, title_document};
use crate::spread::{Expected, copy_difference, settled_holders, titled};
use crate::support::{decode, write_binary, write_map_header, write_text};

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
