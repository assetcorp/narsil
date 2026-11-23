use narsil::{AnalysisChange, AnalysisSetting, Map, StopWordsSetting, Value, decode_msgpack};
use narsil_cluster::coordinator::etcd::EtcdCoordinator;

use crate::data_node::{DataNode, Scratch, coordinator_at, etcd_endpoint, unique_key_prefix};
use crate::typescript_node::{TypescriptNode, fields};

const ROOKERY: &str = "rookery";
const PARTITION_COUNT: u64 = 3;
const HEARTBEAT_TTL_SECONDS: u64 = 30;
const STOP_WORD_LIST: &str = "fleet-words";
const STOPPED_WORD: &str = "zebra";
const NEST_COUNT: usize = 20;
const SWITCH_WAIT: std::time::Duration = std::time::Duration::from_secs(30);
const SWITCH_POLL: std::time::Duration = std::time::Duration::from_millis(100);

fn nest_title(position: usize) -> String {
    if position.is_multiple_of(2) {
        format!("Zebra finch nest on ledge {position}")
    } else {
        format!("Puffin nest on ledge {position}")
    }
}

async fn settings_of(coordinator: &EtcdCoordinator) -> Map {
    let bytes = coordinator
        .get(&format!("_narsil/index/{ROOKERY}/config"))
        .await
        .expect("etcd answers for the metadata")
        .expect("the index has metadata");
    match decode_msgpack(&bytes) {
        Ok(Value::Object(record)) => match record.get("settings") {
            Some(Value::Object(settings)) => settings.clone(),
            _ => Map::new(),
        },
        _ => panic!("the metadata is a msgpack map"),
    }
}

async fn matching_count(node: &mut TypescriptNode, word: &str) -> usize {
    match node
        .call(
            "matchingIds",
            fields([
                ("indexName", Value::from(ROOKERY)),
                ("term", Value::from(word)),
            ]),
        )
        .await
        .value()
    {
        Value::Array(ids) => ids.len(),
        other => panic!("the TypeScript node lists the matching ids: {other:?}"),
    }
}

fn named_stop_words() -> AnalysisChange {
    AnalysisChange {
        stop_words: AnalysisSetting::Set(StopWordsSetting::Named(STOP_WORD_LIST.to_string())),
        ..AnalysisChange::default()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_node_changes_the_analysis_of_a_cluster_index_and_returns_once_it_is_published() {
    let Some(endpoint) = etcd_endpoint() else {
        return;
    };
    let key_prefix = unique_key_prefix();
    let coordinator =
        coordinator_at(endpoint.clone(), key_prefix.clone(), HEARTBEAT_TTL_SECONDS).await;
    let controller_scratch = Scratch::new();
    let controller = DataNode::start_with_roles(
        &coordinator,
        "rookery-controller",
        controller_scratch.path(),
        &["controller"],
    )
    .await;
    let mut ledge_a =
        TypescriptNode::start(&endpoint, &key_prefix, "rookery-ledge-a", "data").await;
    let ledge_b = TypescriptNode::start(&endpoint, &key_prefix, "rookery-ledge-b", "data").await;
    let warden_scratch = Scratch::new();
    let warden = DataNode::start_with_roles(
        &coordinator,
        "rookery-warden",
        warden_scratch.path(),
        &["coordinator"],
    )
    .await;
    ledge_a.create_index(ROOKERY, PARTITION_COUNT, 0).await;
    for position in 0..NEST_COUNT {
        let answer = ledge_a
            .insert(ROOKERY, &format!("nest-{position}"), &nest_title(position))
            .await;
        assert_eq!(answer.code(), None);
    }
    assert_eq!(
        matching_count(&mut ledge_a, STOPPED_WORD).await,
        NEST_COUNT / 2
    );

    let missing = warden
        .node
        .change_analysis("rookery-that-was-never-built", &named_stop_words())
        .await
        .expect_err("the node refuses an index that the cluster lacks");
    assert_eq!(missing.code(), "INDEX_NOT_FOUND");
    let unknown = warden
        .node
        .change_analysis(
            ROOKERY,
            &AnalysisChange {
                language: Some("registered-on-no-node".to_string()),
                ..AnalysisChange::default()
            },
        )
        .await
        .expect_err("the holders refuse a language that none of them registered");
    assert_eq!(unknown.code(), "LANGUAGE_NOT_SUPPORTED");
    assert_eq!(settings_of(&coordinator).await.get("pendingAnalysis"), None);

    warden
        .node
        .change_analysis(ROOKERY, &named_stop_words())
        .await
        .expect("the change is published");
    let settings = settings_of(&coordinator).await;
    assert_eq!(settings.get("analysisGeneration"), Some(&Value::from(1.0)));
    assert_eq!(
        settings.get("stopWords"),
        Some(&Value::from(STOP_WORD_LIST))
    );
    let deadline = tokio::time::Instant::now() + SWITCH_WAIT;
    while matching_count(&mut ledge_a, STOPPED_WORD).await != 0 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the TypeScript holder answers under the new stop words"
        );
        tokio::time::sleep(SWITCH_POLL).await;
    }

    warden
        .node
        .change_analysis(ROOKERY, &named_stop_words())
        .await
        .expect("a change to the settings that the index holds completes");
    assert_eq!(
        settings_of(&coordinator).await.get("analysisGeneration"),
        Some(&Value::from(1.0))
    );

    warden.stop().await;
    ledge_a.shutdown().await;
    ledge_b.shutdown().await;
    controller.stop().await;
    coordinator.shutdown().await;
}
