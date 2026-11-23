use narsil::{IndexConfig, Map, Value};
use narsil_cluster::coordinator::etcd::EtcdCoordinator;
use narsil_cluster::node::CreateIndexOptions;

use crate::data_node::{
    DataNode, Scratch, coordinator_at, etcd_endpoint, metadata_key, title_schema, unique_key_prefix,
};
use crate::named_analysis::open_with_named_analysis;
use crate::typescript_node::TypescriptNode;

const KEPT: &str = "harbour-ledger";
const DROPPED: &str = "harbour-manifest";
const PARTITION_COUNT: u32 = 2;
const HEARTBEAT_TTL_SECONDS: u64 = 30;
const ENTRY_COUNT: usize = 16;

fn entry_title(index_name: &str, position: usize) -> String {
    format!("{index_name} entry {position} for the night tide")
}

fn titled(title: &str) -> Map {
    let mut document = Map::new();
    document.insert("title", Value::from(title));
    document
}

fn options() -> CreateIndexOptions {
    CreateIndexOptions {
        partition_count: Some(PARTITION_COUNT),
        replication_factor: Some(1),
        wait_for_serving_ms: None,
    }
}

async fn fill(clerk: &DataNode, index_name: &str) {
    for position in 0..ENTRY_COUNT {
        clerk
            .node
            .insert(
                index_name,
                titled(&entry_title(index_name, position)),
                Some(&format!("entry-{position}")),
            )
            .await
            .unwrap_or_else(|error| panic!("{index_name} takes entry {position}: {error:?}"));
    }
}

async fn stored_documents(node: &mut TypescriptNode, index_name: &str) -> u64 {
    node.partition_counts(index_name)
        .await
        .iter()
        .map(|(_, count)| count)
        .sum()
}

async fn cluster_holds_no_trace_of(coordinator: &EtcdCoordinator, index_name: &str) {
    let metadata = coordinator
        .get(&metadata_key(index_name))
        .await
        .expect("etcd answers for the metadata");
    assert!(metadata.is_none_or(|bytes| bytes.is_empty()));
    assert_eq!(
        coordinator
            .schema(index_name)
            .await
            .expect("etcd answers for the schema"),
        None
    );
    assert!(
        coordinator
            .allocation(index_name)
            .await
            .expect("etcd answers for the table")
            .is_none_or(|table| table.assignments.is_empty())
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_drop_from_a_rust_node_leaves_no_copy_behind_and_keeps_every_document_of_another_index() {
    let Some(endpoint) = etcd_endpoint() else {
        return;
    };
    let key_prefix = unique_key_prefix();
    let coordinator =
        coordinator_at(endpoint.clone(), key_prefix.clone(), HEARTBEAT_TTL_SECONDS).await;
    let controller_scratch = Scratch::new();
    let controller = DataNode::start_with_roles(
        &coordinator,
        "harbour-controller",
        controller_scratch.path(),
        &["controller"],
    )
    .await;
    let clerk_scratch = Scratch::new();
    let clerk = DataNode::start(&coordinator, "harbour-clerk", clerk_scratch.path()).await;
    let mut wharf = TypescriptNode::start(&endpoint, &key_prefix, "harbour-wharf", "data").await;

    for index_name in [KEPT, DROPPED] {
        clerk
            .node
            .create_index(index_name, IndexConfig::new(title_schema()), options())
            .await
            .unwrap_or_else(|error| panic!("the cluster creates {index_name}: {error:?}"));
        fill(&clerk, index_name).await;
    }
    assert_eq!(
        stored_documents(&mut wharf, DROPPED).await,
        ENTRY_COUNT as u64
    );

    clerk
        .node
        .drop_index(DROPPED)
        .await
        .expect("the drop returns once no node holds a copy");
    cluster_holds_no_trace_of(&coordinator, DROPPED).await;
    let gone = wharf
        .call(
            "partitionCounts",
            crate::typescript_node::fields([("indexName", Value::from(DROPPED))]),
        )
        .await;
    assert_eq!(gone.code(), Some("INDEX_NOT_FOUND"));

    clerk
        .node
        .create_index(DROPPED, IndexConfig::new(title_schema()), options())
        .await
        .expect("the name is free again once the drop returns");
    assert_eq!(stored_documents(&mut wharf, DROPPED).await, 0);
    for position in 0..ENTRY_COUNT {
        assert_eq!(
            wharf.title(KEPT, &format!("entry-{position}")).await,
            Some(entry_title(KEPT, position))
        );
    }
    assert_eq!(stored_documents(&mut wharf, KEPT).await, ENTRY_COUNT as u64);

    clerk
        .node
        .drop_index(DROPPED)
        .await
        .expect("the second drop returns once no node holds a copy");
    wharf.shutdown().await;
    clerk.stop().await;
    controller.stop().await;
    coordinator.shutdown().await;

    let engine = open_with_named_analysis(clerk_scratch.path());
    let names: Vec<String> = engine
        .list_indexes()
        .into_iter()
        .map(|index| index.name)
        .collect();
    assert!(!names.iter().any(|name| name == DROPPED), "{names:?}");
    engine.shutdown().expect("the engine closes");
}
