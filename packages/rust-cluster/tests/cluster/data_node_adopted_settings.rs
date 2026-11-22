use std::path::Path;

use narsil::{IndexConfig, Map, Narsil, QueryParams, Value, encode_msgpack};
use sha2::{Digest, Sha256};

use crate::data_node::{
    DataNode, Scratch, cluster_coordinator, engine_config, metadata_key, title_schema,
};

const GARAGE: &str = "garage";
const GARAGE_UUID: &str = "uuid-of-garage";
const SYNONYM_GENERATION: &str = "first-synonym-set";
const SHORT: &str = "short-title";
const LONG: &str = "long-title";
const SYNONYM_ONLY: &str = "synonym-only";
const SCORE_TOLERANCE: f64 = 1e-9;

fn titled(title: &str) -> Map {
    let mut document = Map::new();
    document.insert("title", Value::from(title));
    document
}

fn store_copy_without_identity(directory: &Path) {
    let engine = Narsil::open(engine_config(directory)).expect("the engine opens");
    engine
        .create_index(GARAGE, IndexConfig::new(title_schema()))
        .expect("the copy is created");
    for (id, title) in [
        (SHORT, "car"),
        (LONG, "car alpha beta gamma delta epsilon zeta eta"),
        (SYNONYM_ONLY, "automobile"),
    ] {
        engine
            .insert(GARAGE, titled(title), Some(id))
            .expect("the copy takes the document");
    }
    let before = car_hits(&engine);
    assert!(
        before.iter().all(|(id, _)| id != SYNONYM_ONLY),
        "the default synonym set matched the synonym: {before:?}"
    );
    assert!(
        score_of(&before, SHORT) > score_of(&before, LONG) + SCORE_TOLERANCE,
        "the default BM25 setting ignores title length: {before:?}"
    );
    engine.shutdown().expect("the engine closes");
}

fn car_hits(engine: &Narsil) -> Vec<(String, f64)> {
    let query = QueryParams {
        term: Some("car".into()),
        ..QueryParams::default()
    };
    engine
        .query(GARAGE, &query)
        .expect("the copy answers the search")
        .hits
        .into_iter()
        .map(|hit| (hit.id, hit.score.unwrap_or(f64::NAN)))
        .collect()
}

fn score_of(hits: &[(String, f64)], id: &str) -> f64 {
    hits.iter()
        .find(|(hit, _)| hit == id)
        .map(|(_, score)| *score)
        .unwrap_or_else(|| panic!("{id} is missing from {hits:?}"))
}

fn object(fields: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    for (name, value) in fields {
        map.insert(name, value);
    }
    Value::Object(map)
}

fn synonym_set() -> Vec<u8> {
    let rule = object(vec![(
        "words",
        Value::Array(vec![Value::from("car"), Value::from("automobile")]),
    )]);
    encode_msgpack(&Value::Array(vec![rule])).expect("the synonym set encodes")
}

fn metadata_with_settings(synonyms: &[u8]) -> Vec<u8> {
    let digest: String = Sha256::digest(synonyms)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let settings = object(vec![
        ("language", Value::from("english")),
        (
            "bm25",
            object(vec![("k1", Value::Number(1.2)), ("b", Value::Number(0.0))]),
        ),
        (
            "synonyms",
            object(vec![
                ("generation", Value::from(SYNONYM_GENERATION)),
                ("digest", Value::from(digest.as_str())),
                ("chunkCount", Value::Number(1.0)),
                ("byteLength", Value::Number(synonyms.len() as f64)),
            ]),
        ),
    ]);
    let record = object(vec![
        ("indexName", Value::from(GARAGE)),
        ("indexUuid", Value::from(GARAGE_UUID)),
        ("partitionCount", Value::Number(1.0)),
        ("replicationFactor", Value::Number(0.0)),
        ("constraints", object(Vec::new())),
        ("settings", settings),
    ]);
    encode_msgpack(&record).expect("the metadata encodes")
}

#[tokio::test(flavor = "multi_thread")]
async fn an_adopted_copy_searches_with_the_synonyms_and_bm25_setting_that_the_cluster_stores() {
    let Some(coordinator) = cluster_coordinator().await else {
        return;
    };
    let scratch = Scratch::new();
    store_copy_without_identity(scratch.path());
    let synonyms = synonym_set();
    let chunk_key = format!("_narsil/synonyms/{GARAGE_UUID}/{SYNONYM_GENERATION}/0");
    assert!(
        coordinator
            .compare_and_set(&chunk_key, None, &synonyms)
            .await
            .expect("etcd takes the synonym set")
    );
    assert!(
        coordinator
            .compare_and_set(
                &metadata_key(GARAGE),
                None,
                &metadata_with_settings(&synonyms)
            )
            .await
            .expect("etcd takes the metadata")
    );
    coordinator
        .put_schema(GARAGE, &title_schema())
        .await
        .expect("etcd takes the schema");

    let data = DataNode::start(&coordinator, "data-a", scratch.path()).await;
    let adopted = data
        .node
        .local_document(GARAGE, SHORT)
        .await
        .expect("the adopted copy answers");
    assert_eq!(adopted, Some(titled("car")));
    let reported = data.reported.lock().expect("no reporter panicked").clone();
    assert!(reported.is_empty(), "the node reported {reported:?}");
    data.stop().await;
    coordinator.shutdown().await;

    let engine = Narsil::open(engine_config(scratch.path())).expect("the engine opens again");
    let after = car_hits(&engine);
    let mut matched: Vec<&str> = after.iter().map(|(id, _)| id.as_str()).collect();
    matched.sort_unstable();
    assert_eq!(matched, [LONG, SHORT, SYNONYM_ONLY]);
    assert!(
        (score_of(&after, SHORT) - score_of(&after, LONG)).abs() < SCORE_TOLERANCE,
        "b of 0 ignores title length: {after:?}"
    );
    engine.shutdown().expect("the engine closes");
}
