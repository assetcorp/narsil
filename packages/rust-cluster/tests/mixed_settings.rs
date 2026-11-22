use narsil::{Narsil, QueryParams, Value};
use narsil_cluster::coordinator::etcd::{EtcdCoordinator, EtcdCoordinatorConfig};

mod data_node;
mod ledger;
mod spread;
mod support;
mod typescript_node;

use data_node::{
    DataNode, Scratch, coordinator_at, engine_config, etcd_endpoint, eventually, unique_key_prefix,
};
use ledger::start_controller;
use spread::titled;
use typescript_node::{TypescriptNode, fields};

const FRENCH: &str = "french-garage";
const CUSTOM: &str = "custom-garage";
const RUST_DATA_NODE: &str = "settings-rust-data";
const CAPACITY: u64 = 4;
const SCORE_TOLERANCE: f64 = 1e-9;
const CAPACITY_EXCEEDED: &str = "PARTITION_CAPACITY_EXCEEDED";

fn object<const N: usize>(entries: [(&str, Value); N]) -> Value {
    Value::Object(fields(entries))
}

fn scored_hits(engine: &Narsil, index_name: &str, term: &str) -> Vec<(String, f64)> {
    let query = QueryParams {
        term: Some(term.into()),
        ..QueryParams::default()
    };
    let mut hits: Vec<(String, f64)> = engine
        .query(index_name, &query)
        .unwrap_or_else(|error| panic!("the copy of {index_name} answers '{term}': {error:?}"))
        .hits
        .into_iter()
        .map(|hit| (hit.id, hit.score.unwrap_or(f64::NAN)))
        .collect();
    hits.sort_by(|left, right| left.0.cmp(&right.0));
    hits
}

fn hit_ids(engine: &Narsil, index_name: &str, term: &str) -> Vec<String> {
    scored_hits(engine, index_name, term)
        .into_iter()
        .map(|(id, _)| id)
        .collect()
}

async fn led_by_the_rust_node(coordinator: &EtcdCoordinator, index_name: &str) {
    eventually("the Rust data node leads the index", || async {
        coordinator
            .allocation(index_name)
            .await
            .ok()
            .flatten()
            .and_then(|table| {
                table.assignments.first().map(|(_, assignment)| {
                    assignment.get("state").and_then(Value::as_str) == Some("ACTIVE")
                        && assignment.get("primary").and_then(Value::as_str) == Some(RUST_DATA_NODE)
                })
            })
            .unwrap_or(false)
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_copy_analyses_scores_and_caps_with_the_settings_that_a_typescript_node_stored() {
    let Some(endpoint) = etcd_endpoint() else {
        return;
    };
    let key_prefix = unique_key_prefix();
    let ttl = EtcdCoordinatorConfig::default().node_heartbeat_ttl_seconds;
    let coordinator = coordinator_at(endpoint.clone(), key_prefix.clone(), ttl).await;
    let controller_scratch = Scratch::new();
    let controller = start_controller(&coordinator, &controller_scratch).await;
    let data_scratch = Scratch::new();
    let data = DataNode::start(&coordinator, RUST_DATA_NODE, data_scratch.path()).await;
    let mut creator = TypescriptNode::start(
        &endpoint,
        &key_prefix,
        "settings-ts-coordinator",
        "coordinator",
    )
    .await;
    creator
        .create_index_with(FRENCH, 1, 0, fields([("language", Value::from("french"))]))
        .await;
    creator
        .create_index_with(
            CUSTOM,
            1,
            0,
            fields([
                ("stopWords", Value::Array(vec![Value::from("garage")])),
                (
                    "bm25",
                    object([("k1", Value::Number(1.2)), ("b", Value::Number(0.0))]),
                ),
                (
                    "partitions",
                    object([("maxDocsPerPartition", Value::from(CAPACITY))]),
                ),
            ]),
        )
        .await;
    led_by_the_rust_node(&coordinator, FRENCH).await;
    led_by_the_rust_node(&coordinator, CUSTOM).await;
    let router_scratch = Scratch::new();
    let router = DataNode::start_with_roles(
        &coordinator,
        "settings-rust-router",
        router_scratch.path(),
        &["coordinator"],
    )
    .await;

    creator
        .insert(FRENCH, "le-garage", "le garage")
        .await
        .value();
    router
        .node
        .insert(FRENCH, titled("la voiture"), Some("la-voiture"))
        .await
        .expect("the Rust primary takes the insert");
    creator.insert(CUSTOM, "short", "car").await.value();
    creator
        .insert(CUSTOM, "long", "car the open road at night")
        .await
        .value();
    router
        .node
        .insert(CUSTOM, titled("garage zebra"), Some("zebra"))
        .await
        .expect("the Rust primary takes the insert");
    router
        .node
        .insert(CUSTOM, titled("the fourth"), Some("fourth"))
        .await
        .expect("the Rust primary takes the insert");
    let past_capacity = creator.insert(CUSTOM, "fifth", "one too many").await;
    assert_eq!(
        past_capacity.code(),
        Some(CAPACITY_EXCEEDED),
        "{past_capacity:?}"
    );
    let past_capacity = router
        .node
        .insert(CUSTOM, titled("one too many"), Some("sixth"))
        .await
        .expect_err("the Rust primary refuses a write past the partition's capacity");
    assert_eq!(past_capacity.code(), CAPACITY_EXCEEDED, "{past_capacity:?}");

    router.stop().await;
    creator.shutdown().await;
    data.stop().await;
    controller.stop().await;
    coordinator.shutdown().await;

    let engine = Narsil::open(engine_config(data_scratch.path())).expect("the engine opens again");
    assert_eq!(
        hit_ids(&engine, FRENCH, "le"),
        Vec::<String>::new(),
        "French drops 'le' as a stop word"
    );
    assert_eq!(hit_ids(&engine, FRENCH, "la"), Vec::<String>::new());
    assert_eq!(hit_ids(&engine, FRENCH, "garage"), ["le-garage"]);
    assert_eq!(hit_ids(&engine, FRENCH, "voiture"), ["la-voiture"]);
    assert_eq!(
        hit_ids(&engine, CUSTOM, "garage"),
        Vec::<String>::new(),
        "the custom list drops 'garage'"
    );
    assert_eq!(
        hit_ids(&engine, CUSTOM, "the"),
        ["fourth", "long"],
        "the custom list replaces the English stop words"
    );
    assert_eq!(hit_ids(&engine, CUSTOM, "zebra"), ["zebra"]);
    let car = scored_hits(&engine, CUSTOM, "car");
    assert_eq!(car.len(), 2, "{car:?}");
    assert!(
        (car[0].1 - car[1].1).abs() < SCORE_TOLERANCE,
        "b of 0 ignores title length: {car:?}"
    );
    assert_eq!(hit_ids(&engine, CUSTOM, "many"), Vec::<String>::new());
    engine.shutdown().expect("the engine closes");
}
