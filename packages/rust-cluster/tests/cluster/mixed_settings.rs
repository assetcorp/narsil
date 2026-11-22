use narsil::{Map, Narsil, QueryParams, Value, VectorQuery};
use narsil_cluster::coordinator::etcd::{EtcdCoordinator, EtcdCoordinatorConfig};

use crate::data_node::{
    DataNode, Scratch, coordinator_at, engine_config, etcd_endpoint, eventually, unique_key_prefix,
};
use crate::ledger::start_controller;
use crate::named_analysis::{
    ADAPTER_NAME, STOP_WORDS_NAME, TOKENIZER_NAME, letter_shape, open_with_named_analysis,
    with_named_analysis, with_named_analysis_except_stop_words,
};
use crate::spread::titled;
use crate::typescript_node::{TypescriptNode, fields};

const FRENCH: &str = "french-garage";
const CUSTOM: &str = "custom-garage";
const NAMED_STOPS: &str = "named-stop-garage";
const NAMED_TOKENS: &str = "named-token-garage";
const PLAIN: &str = "plain-garage";
const RUST_DATA_NODE: &str = "settings-rust-data";
const UNEQUIPPED_DATA_NODE: &str = "settings-rust-data-without-names";
const WRITES_WHILE_REFUSED: usize = 10;
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

async fn assignment_of(coordinator: &EtcdCoordinator, index_name: &str) -> Option<Map> {
    let table = coordinator.allocation(index_name).await.ok().flatten()?;
    table
        .assignments
        .first()
        .map(|(_, assignment)| assignment.clone())
}

fn lists(assignment: &Map, name: &str, node_id: &str) -> bool {
    matches!(
        assignment.get(name),
        Some(Value::Array(items)) if items.iter().any(|item| item.as_str() == Some(node_id))
    )
}

async fn led_by(coordinator: &EtcdCoordinator, index_name: &str, node_id: &str) {
    eventually("the Rust data node leads the index", || async {
        assignment_of(coordinator, index_name)
            .await
            .is_some_and(|assignment| {
                assignment.get("state").and_then(Value::as_str) == Some("ACTIVE")
                    && assignment.get("primary").and_then(Value::as_str) == Some(node_id)
            })
    })
    .await;
}

async fn led_by_the_rust_node(coordinator: &EtcdCoordinator, index_name: &str) {
    led_by(coordinator, index_name, RUST_DATA_NODE).await;
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

fn named_stops_config() -> narsil::Map {
    fields([
        (
            "schema",
            object([
                ("title", Value::from("string")),
                ("shape", Value::from("vector[3]")),
            ]),
        ),
        ("stopWords", Value::from(STOP_WORDS_NAME)),
        (
            "embedding",
            object([
                ("adapter", Value::from(ADAPTER_NAME)),
                ("fields", object([("shape", Value::from("title"))])),
            ]),
        ),
    ])
}

fn nearest(engine: &Narsil, index_name: &str, text: &str) -> Option<String> {
    let query = QueryParams {
        vector: Some(VectorQuery {
            field: "shape".to_string(),
            value: Some(letter_shape(text)),
            ..VectorQuery::default()
        }),
        ..QueryParams::default()
    };
    engine
        .query(index_name, &query)
        .unwrap_or_else(|error| {
            panic!("the copy of {index_name} answers a vector search: {error:?}")
        })
        .hits
        .into_iter()
        .next()
        .map(|hit| hit.id)
}

async fn start_named(coordinator: &std::sync::Arc<EtcdCoordinator>, scratch: &Scratch) -> DataNode {
    DataNode::start_configured(
        coordinator,
        RUST_DATA_NODE,
        scratch.path(),
        &["data"],
        with_named_analysis,
    )
    .await
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_copy_of_an_index_that_names_its_analysis_survives_a_restart_and_searches_by_those_names()
 {
    let Some(endpoint) = etcd_endpoint() else {
        return;
    };
    let key_prefix = unique_key_prefix();
    let ttl = EtcdCoordinatorConfig::default().node_heartbeat_ttl_seconds;
    let coordinator = coordinator_at(endpoint.clone(), key_prefix.clone(), ttl).await;
    let controller_scratch = Scratch::new();
    let controller = start_controller(&coordinator, &controller_scratch).await;
    let data_scratch = Scratch::new();
    let data = start_named(&coordinator, &data_scratch).await;
    let mut creator = TypescriptNode::start(
        &endpoint,
        &key_prefix,
        "settings-ts-coordinator",
        "coordinator",
    )
    .await;
    creator
        .create_index_with(NAMED_STOPS, 1, 0, named_stops_config())
        .await;
    creator
        .create_index_with(
            NAMED_TOKENS,
            1,
            0,
            fields([("tokenizer", Value::from(TOKENIZER_NAME))]),
        )
        .await;
    led_by_the_rust_node(&coordinator, NAMED_STOPS).await;
    led_by_the_rust_node(&coordinator, NAMED_TOKENS).await;
    for (document_id, title) in [
        ("zebra", "zebra crossing"),
        ("garage", "the garage door"),
        ("boat", "a boat afloat"),
    ] {
        creator
            .insert(NAMED_STOPS, document_id, title)
            .await
            .value();
    }
    creator
        .insert(NAMED_TOKENS, "colors", "Red Car|Blue Sky")
        .await
        .value();

    data.stop().await;
    let data = start_named(&coordinator, &data_scratch).await;
    led_by_the_rust_node(&coordinator, NAMED_STOPS).await;
    let recovered = data
        .node
        .local_document(NAMED_STOPS, "boat")
        .await
        .expect("the recovered copy answers");
    assert_eq!(
        recovered
            .as_ref()
            .and_then(|document| document.get("title"))
            .and_then(Value::as_str),
        Some("a boat afloat")
    );
    creator
        .insert(NAMED_STOPS, "rowing", "oars and a rowing boat")
        .await
        .value();
    let reported = data.reported.lock().expect("no reporter panicked").clone();
    assert!(reported.is_empty(), "the node reported {reported:?}");

    creator.shutdown().await;
    data.stop().await;
    controller.stop().await;
    coordinator.shutdown().await;

    let engine = open_with_named_analysis(data_scratch.path());
    assert_eq!(hit_ids(&engine, NAMED_STOPS, "zebra"), Vec::<String>::new());
    assert_eq!(
        hit_ids(&engine, NAMED_STOPS, "garage"),
        Vec::<String>::new()
    );
    assert_eq!(hit_ids(&engine, NAMED_STOPS, "crossing"), ["zebra"]);
    assert_eq!(
        hit_ids(&engine, NAMED_STOPS, "the"),
        ["garage"],
        "the named set replaces the English stop words"
    );
    assert_eq!(hit_ids(&engine, NAMED_STOPS, "rowing"), ["rowing"]);
    assert_eq!(
        nearest(&engine, NAMED_STOPS, "a boat afloat").as_deref(),
        Some("boat"),
        "the named adapter embedded each title"
    );
    assert_eq!(
        nearest(&engine, NAMED_STOPS, "zebra crossing").as_deref(),
        Some("zebra")
    );
    assert_eq!(hit_ids(&engine, NAMED_TOKENS, "red car"), ["colors"]);
    assert_eq!(hit_ids(&engine, NAMED_TOKENS, "blue sky"), ["colors"]);
    assert_eq!(
        hit_ids(&engine, NAMED_TOKENS, "red"),
        Vec::<String>::new(),
        "the named tokenizer keeps each piece between pipes whole"
    );
    engine.shutdown().expect("the engine closes");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_node_without_a_named_stop_word_set_refuses_that_copy_and_the_cluster_keeps_serving()
{
    let Some(endpoint) = etcd_endpoint() else {
        return;
    };
    let key_prefix = unique_key_prefix();
    let ttl = EtcdCoordinatorConfig::default().node_heartbeat_ttl_seconds;
    let coordinator = coordinator_at(endpoint.clone(), key_prefix.clone(), ttl).await;
    let controller_scratch = Scratch::new();
    let controller = start_controller(&coordinator, &controller_scratch).await;
    let equipped_scratch = Scratch::new();
    let equipped = start_named(&coordinator, &equipped_scratch).await;
    let mut creator = TypescriptNode::start(
        &endpoint,
        &key_prefix,
        "settings-ts-coordinator",
        "coordinator",
    )
    .await;
    creator
        .create_index_with(NAMED_STOPS, 1, 1, named_stops_config())
        .await;
    led_by_the_rust_node(&coordinator, NAMED_STOPS).await;
    let unequipped_scratch = Scratch::new();
    let unequipped = DataNode::start_configured(
        &coordinator,
        UNEQUIPPED_DATA_NODE,
        unequipped_scratch.path(),
        &["data"],
        with_named_analysis_except_stop_words,
    )
    .await;
    let engine_refusal =
        format!("Stop word set \"{STOP_WORDS_NAME}\" is not registered on this engine");
    eventually(
        "the unequipped node reports the name that it lacks",
        || async {
            unequipped
                .reported
                .lock()
                .expect("no reporter panicked")
                .iter()
                .any(|error| {
                    error.code() == "NODE_BOOTSTRAP_FAILED"
                        && error
                            .details()
                            .get("cause")
                            .and_then(Value::as_str)
                            .is_some_and(|cause| cause.contains(&engine_refusal))
                })
        },
    )
    .await;

    for serial in 0..WRITES_WHILE_REFUSED {
        let document_id = format!("while-refused-{serial}");
        creator
            .insert(NAMED_STOPS, &document_id, "a boat afloat")
            .await
            .value();
        let assignment = assignment_of(&coordinator, NAMED_STOPS)
            .await
            .expect("the index is placed");
        assert_eq!(
            assignment.get("primary").and_then(Value::as_str),
            Some(RUST_DATA_NODE)
        );
        assert!(
            !lists(&assignment, "inSyncSet", UNEQUIPPED_DATA_NODE),
            "a node that cannot build the copy never joins the in-sync set"
        );
    }
    assert!(
        matches!(
            unequipped
                .node
                .local_document(NAMED_STOPS, "while-refused-0")
                .await,
            Ok(None) | Err(_)
        ),
        "the unequipped node holds no copy"
    );

    creator.create_index(PLAIN, 1, 1).await;
    eventually(
        "the unequipped node serves an index that names nothing",
        || async {
            assignment_of(&coordinator, PLAIN)
                .await
                .is_some_and(|assignment| {
                    assignment.get("state").and_then(Value::as_str) == Some("ACTIVE")
                        && lists(&assignment, "inSyncSet", UNEQUIPPED_DATA_NODE)
                })
        },
    )
    .await;
    creator
        .insert(PLAIN, "plain", "a plain title")
        .await
        .value();
    let plain_holders = [&equipped, &unequipped];
    for holder in plain_holders {
        eventually("each copy of the plain index takes the write", || async {
            matches!(
                holder.node.local_document(PLAIN, "plain").await,
                Ok(Some(_))
            )
        })
        .await;
    }

    creator.shutdown().await;
    unequipped.stop().await;
    equipped.stop().await;
    controller.stop().await;
    coordinator.shutdown().await;
}
