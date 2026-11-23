use narsil::{Map, Narsil, QueryParams, Value, decode_msgpack, encode_msgpack};
use narsil_cluster::coordinator::etcd::EtcdCoordinator;

use crate::data_node::{
    DataNode, Scratch, coordinator_at, etcd_endpoint, eventually, metadata_key, unique_key_prefix,
};
use crate::named_analysis::{open_with_named_analysis, with_named_analysis};
use crate::typescript_node::{TypescriptNode, fields};

const AVIARY: &str = "aviary";
const PARTITION_COUNT: u64 = 3;
const HEARTBEAT_TTL_SECONDS: u64 = 30;
const CONTROLLER: &str = "aviary-controller";
const KEEPER: &str = "aviary-keeper";
const PERCH_A: &str = "aviary-perch-a";
const PERCH_B: &str = "aviary-perch-b";
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

async fn wait_until_stop_words_apply(node: &mut TypescriptNode) {
    let deadline = tokio::time::Instant::now() + SWITCH_WAIT;
    while !matching_ids(node, STOPPED_WORD).await.is_empty() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting until {} answers under the new stop words",
            node.node_id
        );
        tokio::time::sleep(SWITCH_POLL).await;
    }
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

async fn write_pending(coordinator: &EtcdCoordinator, pending: Map) {
    let (bytes, _) = stored_settings(coordinator).await;
    let Ok(Value::Object(mut record)) = decode_msgpack(&bytes) else {
        panic!("the metadata is a msgpack map");
    };
    let mut settings = match record.get("settings") {
        Some(Value::Object(settings)) => settings.clone(),
        _ => Map::new(),
    };
    settings.insert("pendingAnalysis", Value::Object(pending));
    record.insert("settings", Value::Object(settings));
    let next = encode_msgpack(&Value::Object(record)).expect("the metadata encodes");
    assert!(
        coordinator
            .compare_and_set(&metadata_key(AVIARY), Some(&bytes), &next)
            .await
            .expect("etcd takes the pending change")
    );
}

struct Aviary {
    coordinator: std::sync::Arc<EtcdCoordinator>,
    controller: DataNode,
    _controller_scratch: Scratch,
    keeper: TypescriptNode,
    perches: Vec<TypescriptNode>,
}

impl Aviary {
    async fn start(endpoint: String) -> Aviary {
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
        let mut keeper = TypescriptNode::start(&endpoint, &key_prefix, KEEPER, "coordinator").await;
        let perch_a = TypescriptNode::start(&endpoint, &key_prefix, PERCH_A, "data").await;
        let perch_b = TypescriptNode::start(&endpoint, &key_prefix, PERCH_B, "data").await;
        keeper.create_index(AVIARY, PARTITION_COUNT, 1).await;
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
        Aviary {
            coordinator,
            controller,
            _controller_scratch: controller_scratch,
            keeper,
            perches: vec![perch_a, perch_b],
        }
    }

    async fn expect_every_node_matches(&mut self, word: &str, expected: &[String]) {
        assert_eq!(matching_ids(&mut self.keeper, word).await, expected);
        for perch in &mut self.perches {
            assert_eq!(matching_ids(perch, word).await, expected);
        }
    }

    async fn stop(self) {
        self.keeper.shutdown().await;
        for perch in self.perches {
            perch.shutdown().await;
        }
        self.controller.stop().await;
        self.coordinator.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_controller_publishes_a_stop_word_change_that_every_typescript_node_answers_under() {
    let Some(endpoint) = etcd_endpoint() else {
        return;
    };
    let mut aviary = Aviary::start(endpoint).await;
    aviary
        .expect_every_node_matches(STOPPED_WORD, &expected_ids(STOPPED_WORD))
        .await;

    let changed = aviary
        .keeper
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
    assert_eq!(published_generation(&aviary.coordinator).await, 1.0);
    let settings = stored_settings(&aviary.coordinator).await.1;
    assert_eq!(settings.get("pendingAnalysis"), None);
    assert_eq!(
        settings.get("stopWords"),
        Some(&Value::from(STOP_WORD_LIST))
    );

    for perch in &mut aviary.perches {
        wait_until_stop_words_apply(perch).await;
    }
    aviary.expect_every_node_matches(STOPPED_WORD, &[]).await;
    aviary
        .expect_every_node_matches(KEPT_WORD, &expected_ids(KEPT_WORD))
        .await;
    aviary.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_controller_finishes_a_change_whose_asker_is_gone() {
    let Some(endpoint) = etcd_endpoint() else {
        return;
    };
    let mut aviary = Aviary::start(endpoint).await;
    write_pending(
        &aviary.coordinator,
        fields([
            ("changeId", Value::from("change-without-asker")),
            ("generation", Value::from(1.0)),
            ("language", Value::from("english")),
            ("stopWords", Value::from(STOP_WORD_LIST)),
        ]),
    )
    .await;

    eventually("the controller publishes generation 1", || async {
        published_generation(&aviary.coordinator).await == 1.0
    })
    .await;
    assert_eq!(
        stored_settings(&aviary.coordinator)
            .await
            .1
            .get("pendingAnalysis"),
        None
    );
    for perch in &mut aviary.perches {
        wait_until_stop_words_apply(perch).await;
    }
    aviary
        .expect_every_node_matches(KEPT_WORD, &expected_ids(KEPT_WORD))
        .await;
    aviary.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_controller_records_a_refused_pending_language_and_the_index_keeps_its_terms() {
    let Some(endpoint) = etcd_endpoint() else {
        return;
    };
    let mut aviary = Aviary::start(endpoint).await;
    write_pending(
        &aviary.coordinator,
        fields([
            ("changeId", Value::from("change-to-an-unknown-language")),
            ("generation", Value::from(1.0)),
            ("language", Value::from("registered-on-no-node")),
        ]),
    )
    .await;

    eventually("the controller records the refusal", || async {
        let settings = stored_settings(&aviary.coordinator).await.1;
        matches!(
            settings.get("analysisFailure"),
            Some(Value::Object(failure))
                if failure.get("changeId") == Some(&Value::from("change-to-an-unknown-language"))
        )
    })
    .await;
    let settings = stored_settings(&aviary.coordinator).await.1;
    assert_eq!(settings.get("pendingAnalysis"), None);
    assert_eq!(settings.get("analysisGeneration"), None);
    let Some(Value::Object(failure)) = settings.get("analysisFailure") else {
        panic!("the metadata records the failure");
    };
    assert_eq!(
        failure.get("code"),
        Some(&Value::from("LANGUAGE_NOT_SUPPORTED"))
    );
    aviary
        .expect_every_node_matches(STOPPED_WORD, &expected_ids(STOPPED_WORD))
        .await;

    let changed = aviary
        .keeper
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
    assert_eq!(published_generation(&aviary.coordinator).await, 1.0);
    for perch in &mut aviary.perches {
        wait_until_stop_words_apply(perch).await;
    }
    aviary.stop().await;
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
    let mut keeper = TypescriptNode::start(&endpoint, &key_prefix, KEEPER, "coordinator").await;
    let typescript_perch = TypescriptNode::start(&endpoint, &key_prefix, PERCH_A, "data").await;
    keeper.create_index(AVIARY, PARTITION_COUNT, 0).await;
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
