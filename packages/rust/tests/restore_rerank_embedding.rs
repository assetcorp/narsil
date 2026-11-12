mod support;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, mpsc};
use std::time::Duration;

use narsil::{
    AdapterSetting, DurabilityConfig, EmbeddingConfig, ErrorCode, IndexConfig, Map, Narsil,
    NarsilConfig, QueryParams, RerankConfig, Storage, Value, VectorQuery, parse_json,
};
use support::ScratchDirectory;
use support::adapters::{EmbedWith, RerankWith};
use support::portable::{Tier, snapshot_of};

const INDEX: &str = "documents";
const RERANK_TIMEOUT_MS: u64 = 1_000;
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(10);
const QUERY_RERANKS_BEFORE_REFUSAL: usize = 3;

fn config() -> IndexConfig {
    IndexConfig {
        schema: parse_json(r#"{"title":"string","embedding":"vector[2]"}"#).unwrap(),
        text_storage: Some(Storage::Disk),
        embedding: Some(EmbeddingConfig {
            fields: vec![("embedding".into(), vec!["title".into()])],
            adapter: Some(AdapterSetting::Named("restoring".into())),
        }),
        ..IndexConfig::default()
    }
}

fn insert(engine: &Narsil) {
    let mut document = Map::new();
    document.insert("title", Value::String("wanted".into()));
    document.insert(
        "embedding",
        Value::Array(vec![Value::Number(0.0), Value::Number(1.0)]),
    );
    engine.insert(INDEX, document, Some("wanted")).unwrap();
}

fn require_embedding_from_rerank(preflight: bool) {
    let root = ScratchDirectory::new("restore-rerank-embedding");
    let source = Tier::Log.open(&root.path().join("source"));
    source
        .register_embedding_adapter(
            "restoring",
            Arc::new(EmbedWith {
                dimensions: 2,
                embed: |_: &str| Ok(vec![0.0, 1.0]),
            }),
        )
        .unwrap();
    source.create_index(INDEX, config()).unwrap();
    insert(&source);
    let archive = snapshot_of(&source, INDEX);
    source.shutdown().unwrap();

    let target = Arc::new(
        Narsil::open(NarsilConfig {
            durability: Some(DurabilityConfig {
                directory: Some(root.path().join("target")),
                ..DurabilityConfig::default()
            }),
            rerank_timeout_ms: Some(RERANK_TIMEOUT_MS),
            ..NarsilConfig::default()
        })
        .unwrap(),
    );
    let restoring = Arc::downgrade(&target);
    let (entered, entering) = mpsc::channel();
    target
        .register_embedding_adapter(
            "restoring",
            Arc::new(EmbedWith {
                dimensions: 2,
                embed: move |_: &str| {
                    entered.send(()).unwrap();
                    restoring
                        .upgrade()
                        .unwrap()
                        .restore(INDEX, &mut archive.as_slice())?;
                    Ok(vec![0.0, 1.0])
                },
            }),
        )
        .unwrap();
    target.create_index(INDEX, config()).unwrap();
    insert(&target);
    target.checkpoint(INDEX).unwrap();

    let searching = Arc::downgrade(&target);
    let (finished, finishing) = mpsc::channel();
    let reranks = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&reranks);
    target
        .register_rerank_adapter(
            "searching",
            Arc::new(RerankWith(move |_: &str, documents: &[String]| {
                counted.fetch_add(1, Ordering::SeqCst);
                let params = QueryParams {
                    vector: Some(VectorQuery {
                        field: "embedding".into(),
                        text: Some("search".into()),
                        similarity: Some(0.9),
                        ..VectorQuery::default()
                    }),
                    ..QueryParams::default()
                };
                let engine = searching.upgrade().unwrap();
                let count = if preflight {
                    engine.preflight(INDEX, &params)?.count
                } else {
                    engine.query(INDEX, &params)?.count
                };
                finished.send(count).unwrap();
                Ok(vec![1.0; documents.len()])
            })),
        )
        .unwrap();
    let outcome = target.query(
        INDEX,
        &QueryParams {
            term: Some("wanted".into()),
            rerank: Some(RerankConfig {
                adapter: "searching".into(),
                fields: vec!["title".into()],
                ..RerankConfig::default()
            }),
            ..QueryParams::default()
        },
    );
    entering
        .recv_timeout(CALLBACK_TIMEOUT)
        .expect("the nested search reaches its embedding callback");
    assert_eq!(finishing.recv_timeout(CALLBACK_TIMEOUT).unwrap(), 1);
    target.shutdown().unwrap();
    let error = outcome.expect_err("the outer query refuses once every rerank call restores");
    assert_eq!(error.code(), ErrorCode::WORKER_BUSY, "{error}");
    assert_eq!(reranks.load(Ordering::SeqCst), QUERY_RERANKS_BEFORE_REFUSAL);
}

#[test]
fn a_query_refuses_once_an_embedding_from_each_rerank_restores_the_same_index() {
    require_embedding_from_rerank(false);
}

#[test]
fn a_preflight_embedding_from_each_rerank_restoring_the_same_index_refuses_the_query() {
    require_embedding_from_rerank(true);
}
