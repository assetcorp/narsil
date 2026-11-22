use std::path::Path;

use narsil::replication::{PartitionCopies, PrimaryLimits, PrimaryWrite};
use narsil::{IndexConfig, Map, Narsil, Value};

use crate::data_node::{
    DataNode, Scratch, cluster_coordinator, engine_config, metadata_key, metadata_record,
};

const FORGOTTEN: &str = "forgotten";
const GARBLED: &str = "garbled";
const REPLACED: &str = "replaced";
const HELD: &str = "held";
const DOCUMENT_ID: &str = "invoice-1";
const TITLE: &str = "the only copy of this invoice";
const ENTRY_LIMIT_BYTES: u64 = 1_048_576;

fn uuid_of(index: &str) -> String {
    format!("uuid-of-{index}")
}

fn store_copies(directory: &Path) {
    let engine = Narsil::open(engine_config(directory)).expect("the engine opens");
    let copies = PartitionCopies::new(&engine);
    for index in [FORGOTTEN, GARBLED, REPLACED, HELD] {
        let mut schema = Map::new();
        schema.insert("title", Value::from("string"));
        copies
            .create_index(
                index,
                IndexConfig::new(Value::Object(schema)),
                &uuid_of(index),
                1,
            )
            .expect("the copy is created");
        let mut document = Map::new();
        document.insert("title", Value::from(TITLE));
        let written = copies
            .write(
                index,
                0,
                1,
                vec![PrimaryWrite::Insert {
                    document_id: DOCUMENT_ID.to_string(),
                    document,
                }],
                PrimaryLimits {
                    records_previous_documents: false,
                    max_entry_bytes: ENTRY_LIMIT_BYTES,
                },
            )
            .expect("the copy takes the write");
        assert!(written.failure.is_none());
        assert!(written.outcomes.iter().all(Result::is_ok));
    }
    engine.shutdown().expect("the engine closes");
}

fn stored_title(directory: &Path, index: &str) -> Option<String> {
    let engine = Narsil::open(engine_config(directory)).expect("the engine opens again");
    let held = engine.list_indexes().iter().any(|info| info.name == index);
    let title = held
        .then(|| {
            engine
                .get(index, DOCUMENT_ID)
                .expect("the stored copy reads")
        })
        .flatten()
        .and_then(|document| {
            document
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    engine.shutdown().expect("the engine closes");
    title
}

#[tokio::test(flavor = "multi_thread")]
async fn a_data_node_serves_no_orphaned_copy_and_deletes_one_only_when_asked() {
    let Some(coordinator) = cluster_coordinator().await else {
        return;
    };
    let scratch = Scratch::new();
    store_copies(scratch.path());
    for (index, record) in [
        (GARBLED, vec![0x81, 0xa1, b'x', 0xc3]),
        (
            REPLACED,
            metadata_record(REPLACED, "uuid-of-the-new-index", 1, 0),
        ),
        (HELD, metadata_record(HELD, &uuid_of(HELD), 1, 0)),
    ] {
        assert!(
            coordinator
                .compare_and_set(&metadata_key(index), None, &record)
                .await
                .expect("etcd takes the metadata")
        );
    }

    let data = DataNode::start(&coordinator, "data-a", scratch.path()).await;

    for index in [FORGOTTEN, GARBLED] {
        let refused = data
            .node
            .local_document(index, DOCUMENT_ID)
            .await
            .expect_err("an orphaned copy answers no read");
        assert_eq!(refused.code(), "INDEX_ORPHANED");
        assert_eq!(
            refused.details().get("indexName").and_then(Value::as_str),
            Some(index)
        );
        let reported = data.reported.lock().expect("no reporter panicked").clone();
        assert!(
            reported.iter().any(|error| error.code() == "INDEX_ORPHANED"
                && error.details().get("indexName").and_then(Value::as_str) == Some(index)),
            "{index} was not reported in {reported:?}"
        );
    }

    let mut overwrite = Map::new();
    overwrite.insert("title", Value::from("a write that no copy may take"));
    let refused_insert = data
        .node
        .insert(FORGOTTEN, overwrite.clone(), Some(DOCUMENT_ID))
        .await
        .expect_err("an orphaned copy takes no write");
    assert_eq!(refused_insert.code(), "INDEX_ORPHANED");
    assert_eq!(
        refused_insert
            .details()
            .get("indexName")
            .and_then(Value::as_str),
        Some(FORGOTTEN)
    );
    assert_eq!(
        refused_insert
            .details()
            .get("nodeId")
            .and_then(Value::as_str),
        Some("data-a")
    );
    let refused_batch = data
        .node
        .insert_batch(FORGOTTEN, vec![overwrite.clone()])
        .await
        .expect_err("an orphaned copy takes no batch");
    assert_eq!(refused_batch.code(), "INDEX_ORPHANED");
    let refused_remove = data
        .node
        .remove(FORGOTTEN, DOCUMENT_ID)
        .await
        .expect_err("an orphaned copy takes no remove");
    assert_eq!(refused_remove.code(), "INDEX_ORPHANED");
    let unknown = data
        .node
        .insert("never-held", overwrite, Some(DOCUMENT_ID))
        .await
        .expect_err("a name that no copy holds takes no write");
    assert_eq!(unknown.code(), "INDEX_NOT_FOUND");

    let replaced = data
        .node
        .local_document(REPLACED, DOCUMENT_ID)
        .await
        .expect_err("the node dropped the copy of the replaced index");
    assert_eq!(replaced.code(), "INDEX_NOT_FOUND");
    let held = data
        .node
        .local_document(HELD, DOCUMENT_ID)
        .await
        .expect("the adopted copy answers")
        .expect("the adopted copy holds the document");
    assert_eq!(held.get("title").and_then(Value::as_str), Some(TITLE));

    assert!(
        coordinator
            .compare_and_set(
                &metadata_key(FORGOTTEN),
                None,
                &metadata_record(FORGOTTEN, "uuid-created-again", 1, 0),
            )
            .await
            .expect("another caller creates the name again")
    );
    let refused = data
        .node
        .local_document(FORGOTTEN, DOCUMENT_ID)
        .await
        .expect_err("a later index of the name does not adopt the orphaned copy");
    assert_eq!(refused.code(), "INDEX_ORPHANED");
    let mut later_write = Map::new();
    later_write.insert("title", Value::from("a write to the index created again"));
    let refused_later = data
        .node
        .insert(FORGOTTEN, later_write, Some(DOCUMENT_ID))
        .await
        .expect_err("a node that keeps an orphaned copy routes no write for that name");
    assert_eq!(refused_later.code(), "INDEX_ORPHANED");

    let not_orphaned = data
        .node
        .drop_orphaned_copy(HELD)
        .await
        .expect_err("the drop takes only an orphaned copy");
    assert_eq!(not_orphaned.code(), "CONFIG_INVALID");
    data.node
        .drop_orphaned_copy(FORGOTTEN)
        .await
        .expect("an operator can drop an orphaned copy");
    let dropped = data
        .node
        .local_document(FORGOTTEN, DOCUMENT_ID)
        .await
        .expect_err("the dropped copy is gone");
    assert_eq!(dropped.code(), "INDEX_NOT_FOUND");

    data.stop().await;
    coordinator.shutdown().await;

    assert_eq!(
        stored_title(scratch.path(), GARBLED).as_deref(),
        Some(TITLE)
    );
    assert_eq!(stored_title(scratch.path(), HELD).as_deref(), Some(TITLE));
    assert_eq!(stored_title(scratch.path(), FORGOTTEN), None);
    assert_eq!(stored_title(scratch.path(), REPLACED), None);
}
