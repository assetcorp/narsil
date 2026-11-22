use std::path::Path;

use narsil::replication::{PartitionCopies, PrimaryLimits, PrimaryWrite};
use narsil::{IndexConfig, Map, Narsil, Value};

mod data_node;
mod support;

use data_node::{
    DataNode, Scratch, cluster_coordinator, create_cluster_index, engine_config, eventually,
    is_served_by, metadata_key, title_schema,
};

const NODE_ID: &str = "data-a";
const CATALOGUE: &str = "catalogue";
const CATALOGUE_UUID: &str = "uuid-of-catalogue";
const CATALOGUE_PARTITIONS: u64 = 3;
const LOST: &str = "lost-and-created-again";
const EARLIER_UUID: &str = "uuid-of-the-earlier-index";
const LATER_UUID: &str = "uuid-of-the-later-index";
const DOCUMENT_ID: &str = "invoice-1";
const ENTRY_LIMIT_BYTES: u64 = 1_048_576;

fn store_copy_of_earlier_index(directory: &Path) {
    let engine = Narsil::open(engine_config(directory)).expect("the engine opens");
    let copies = PartitionCopies::new(&engine);
    copies
        .create_index(LOST, IndexConfig::new(title_schema()), EARLIER_UUID, 1)
        .expect("the copy is created");
    let mut document = Map::new();
    document.insert("title", Value::from("a document of the earlier index"));
    let written = copies
        .write(
            LOST,
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
    engine.shutdown().expect("the engine closes");
}

async fn local_read(data: &DataNode, index: &str) -> Result<Option<Map>, String> {
    data.node
        .local_document(index, DOCUMENT_ID)
        .await
        .map_err(|error| error.code().to_string())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_data_node_leads_what_it_is_given_and_never_lends_an_orphaned_copy_to_a_later_index() {
    let Some(coordinator) = cluster_coordinator().await else {
        return;
    };
    let scratch = Scratch::new();
    store_copy_of_earlier_index(scratch.path());
    let data = DataNode::start_with_roles(
        &coordinator,
        NODE_ID,
        scratch.path(),
        &["data", "controller"],
    )
    .await;

    create_cluster_index(
        &coordinator,
        CATALOGUE,
        CATALOGUE_UUID,
        CATALOGUE_PARTITIONS,
        0,
    )
    .await;
    eventually("every partition of the new index is active", || {
        is_served_by(
            &coordinator,
            CATALOGUE,
            CATALOGUE_UUID,
            CATALOGUE_PARTITIONS as usize,
            NODE_ID,
        )
    })
    .await;
    assert_eq!(local_read(&data, CATALOGUE).await, Ok(None));

    let reports_at_join = data.reported.lock().expect("no reporter panicked").len();
    create_cluster_index(&coordinator, LOST, LATER_UUID, 1, 0).await;
    eventually("the node reports the orphaned copy again", || async {
        data.reported
            .lock()
            .expect("no reporter panicked")
            .iter()
            .skip(reports_at_join)
            .any(|error| error.code() == "INDEX_ORPHANED")
    })
    .await;
    assert!(
        !is_served_by(&coordinator, LOST, LATER_UUID, 1, NODE_ID).await,
        "the node served the later index from the earlier index's copy"
    );
    assert_eq!(
        local_read(&data, LOST).await,
        Err("INDEX_ORPHANED".to_string())
    );

    data.node
        .drop_orphaned_copy(LOST)
        .await
        .expect("an operator can drop the orphaned copy");
    eventually("the later index is active once the orphan is gone", || {
        is_served_by(&coordinator, LOST, LATER_UUID, 1, NODE_ID)
    })
    .await;
    assert_eq!(
        local_read(&data, LOST).await,
        Ok(None),
        "the later index holds a document of the earlier one"
    );

    coordinator
        .drop_schema(CATALOGUE)
        .await
        .expect("the schema is dropped");
    coordinator
        .delete(&metadata_key(CATALOGUE))
        .await
        .expect("the metadata is deleted");
    eventually("the node drops the copy of the dropped index", || async {
        local_read(&data, CATALOGUE).await == Err("INDEX_NOT_FOUND".to_string())
    })
    .await;

    data.stop().await;
    coordinator.shutdown().await;
}
