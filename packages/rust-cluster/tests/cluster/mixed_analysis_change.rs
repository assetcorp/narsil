use narsil::{Map, Narsil, QueryParams, Value, decode_msgpack};
use narsil_cluster::coordinator::etcd::EtcdCoordinator;
use narsil_cluster::node::ClusterNodeConfig;

use crate::data_node::{
    DataNode, Scratch, coordinator_at, etcd_endpoint, metadata_key, unique_key_prefix,
};
use crate::named_analysis::{open_with_named_analysis, with_named_analysis};
use crate::typescript_node::{TypescriptNode, fields};

const AVIARY: &str = "aviary";
const PARTITION_COUNT: u64 = 3;
const HEARTBEAT_TTL_SECONDS: u64 = 30;
const CONTROLLER: &str = "aviary-controller";
const KEEPER: &str = "aviary-keeper";
const PERCH_A: &str = "aviary-perch-a";
const MEMORY_PERCH: &str = "aviary-memory-perch";
const STOP_WORD_LIST: &str = "fleet-words";
const STOPPED_WORD: &str = "zebra";
const KEPT_WORD: &str = "lantern";
const SIGHTING_COUNT: usize = 24;
const SWITCH_WAIT: std::time::Duration = std::time::Duration::from_secs(30);
const SWITCH_POLL: std::time::Duration = std::time::Duration::from_millis(100);

fn sighting_title(position: usize) -> String {
    if position.is_multiple_of(2) {
        format!("Striped zebra seen by lantern light, entry {position}")
    } else {
        format!("Copper heron seen by lantern light, entry {position}")
    }
}

fn expected_ids(word: &str) -> Vec<String> {
    let mut ids: Vec<String> = (0..SIGHTING_COUNT)
        .filter(|position| {
            sighting_title(*position)
                .to_lowercase()
                .split(|character: char| !character.is_alphanumeric())
                .any(|token| token == word)
        })
        .map(|position| format!("sighting-{position}"))
        .collect();
    ids.sort();
    ids
}

async fn matching_ids(node: &mut TypescriptNode, word: &str) -> Vec<String> {
    let Value::Array(ids) = node
        .call(
            "matchingIds",
            fields([
                ("indexName", Value::from(AVIARY)),
                ("term", Value::from(word)),
            ]),
        )
        .await
        .value()
    else {
        panic!("the TypeScript node lists the matching ids");
    };
    ids.iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

async fn stored_settings(coordinator: &EtcdCoordinator) -> (Vec<u8>, Map) {
    let bytes = coordinator
        .get(&metadata_key(AVIARY))
        .await
        .expect("etcd answers for the metadata")
        .expect("the index has metadata");
    let Ok(Value::Object(record)) = decode_msgpack(&bytes) else {
        panic!("the metadata is a msgpack map");
    };
    let settings = match record.get("settings") {
        Some(Value::Object(settings)) => settings.clone(),
        _ => Map::new(),
    };
    (bytes, settings)
}

async fn published_generation(coordinator: &EtcdCoordinator) -> f64 {
    match stored_settings(coordinator)
        .await
        .1
        .get("analysisGeneration")
    {
        Some(Value::Number(generation)) => *generation,
        _ => 0.0,
    }
}

fn in_memory_with_named_analysis(settings: &mut ClusterNodeConfig) {
    with_named_analysis(settings);
    if let Some(data) = settings.data.as_mut() {
        data.engine.durability = None;
    }
}

fn copy_hits(engine: &Narsil, word: &str) -> Vec<String> {
    let query = QueryParams {
        term: Some(word.into()),
        limit: Some(SIGHTING_COUNT),
        ..QueryParams::default()
    };
    let mut ids: Vec<String> = engine
        .query(AVIARY, &query)
        .unwrap_or_else(|error| panic!("the Rust copy answers '{word}': {error:?}"))
        .hits
        .into_iter()
        .map(|hit| hit.id)
        .collect();
    ids.sort();
    ids
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_data_node_builds_a_pending_change_that_the_controller_waits_for_and_its_copy_switches()
 {
    let Some(endpoint) = etcd_endpoint() else {
        return;
    };
    let key_prefix = unique_key_prefix();
    let coordinator =
        coordinator_at(endpoint.clone(), key_prefix.clone(), HEARTBEAT_TTL_SECONDS).await;
    let controller_scratch = Scratch::new();
    let controller = DataNode::start_with_roles(
        &coordinator,
        CONTROLLER,
        controller_scratch.path(),
        &["controller"],
    )
    .await;
    let rust_perch_scratch = Scratch::new();
    let rust_perch = DataNode::start_configured(
        &coordinator,
        "aviary-rust-perch",
        rust_perch_scratch.path(),
        &["data"],
        with_named_analysis,
    )
    .await;
    let memory_perch_scratch = Scratch::new();
    let memory_perch = DataNode::start_configured(
        &coordinator,
        MEMORY_PERCH,
        memory_perch_scratch.path(),
        &["data"],
        in_memory_with_named_analysis,
    )
    .await;
    let mut keeper = TypescriptNode::start(&endpoint, &key_prefix, KEEPER, "coordinator").await;
    let typescript_perch = TypescriptNode::start(&endpoint, &key_prefix, PERCH_A, "data").await;
    keeper.create_index(AVIARY, PARTITION_COUNT, 0).await;
    let table = coordinator
        .allocation(AVIARY)
        .await
        .expect("etcd answers for the table")
        .expect("the index has an allocation table");
    assert!(
        table.assignments.iter().any(|(_, assignment)| assignment
            .get("primary")
            .and_then(Value::as_str)
            == Some(MEMORY_PERCH)),
        "the Rust data node without durability leads a partition"
    );
    for position in 0..SIGHTING_COUNT {
        let answer = keeper
            .insert(
                AVIARY,
                &format!("sighting-{position}"),
                &sighting_title(position),
            )
            .await;
        assert_eq!(answer.code(), None);
    }

    let changed = keeper
        .call(
            "changeAnalysis",
            fields([
                ("indexName", Value::from(AVIARY)),
                (
                    "change",
                    Value::Object(fields([("stopWords", Value::from(STOP_WORD_LIST))])),
                ),
            ]),
        )
        .await;
    assert_eq!(changed.code(), None);
    assert_eq!(published_generation(&coordinator).await, 1.0);
    assert_eq!(
        matching_ids(&mut keeper, KEPT_WORD).await,
        expected_ids(KEPT_WORD)
    );

    keeper.shutdown().await;
    typescript_perch.shutdown().await;
    memory_perch.stop().await;
    rust_perch.stop().await;
    controller.stop().await;
    coordinator.shutdown().await;

    let engine = open_with_named_analysis(rust_perch_scratch.path());
    let held = copy_hits(&engine, KEPT_WORD);
    assert!(
        !held.is_empty(),
        "the Rust data node holds part of the index"
    );
    let expected = expected_ids(KEPT_WORD);
    assert!(held.iter().all(|id| expected.contains(id)));
    let deadline = tokio::time::Instant::now() + SWITCH_WAIT;
    while !copy_hits(&engine, STOPPED_WORD).is_empty() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the Rust copy answers under the new stop words"
        );
        tokio::time::sleep(SWITCH_POLL).await;
    }
    engine.shutdown().expect("the engine closes");
}
