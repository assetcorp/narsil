mod support;

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Weak};

use narsil::{
    AdapterSetting, DocumentProjection, EmbeddingConfig, ErrorCode, FacetSpec, IndexConfig, Map,
    Narsil, QueryParams, RerankConfig, Value, VectorQuery, parse_json,
};
use support::adapters::{EmbedWith, RerankWith};
use support::portable::snapshot_of;

const INDEX: &str = "trails";
const SEARCHED_WORD: &str = "river";
const RERANK_CALLS_WITH_ONE_RESTORE: usize = 2;
const RERANK_CALLS_BEFORE_REFUSAL: usize = 3;
const QUERY_EMBEDDINGS_ACROSS_ONE_ADAPTER_CHANGE: usize = 2;
const SIMILARITY_FLOOR: f64 = 0.9;
const MATCHING_VECTOR: [f32; 2] = [1.0, 0.0];
const OTHER_VECTOR: [f32; 2] = [0.0, 1.0];

const REPLACED_DOCUMENTS: [(&str, &str, &str); 4] = [
    ("shared", "river stone", "old"),
    ("replaced-bend", "river bend", "old"),
    ("replaced-mouth", "river mouth wide", "old"),
    ("replaced-quiet", "quiet river", "old"),
];

const RESTORED_DOCUMENTS: [(&str, &str, &str); 5] = [
    ("shared", "river stone path", "trail"),
    ("restored-crossing", "river crossing", "trail"),
    ("restored-delta", "river delta marsh", "wetland"),
    ("restored-shore", "lake shore", "wetland"),
    ("restored-current", "slow river current water", "wetland"),
];

fn config() -> IndexConfig {
    IndexConfig {
        schema: parse_json(r#"{"title":"string","category":"string"}"#).unwrap(),
        ..IndexConfig::default()
    }
}

fn document(title: &str, category: &str) -> Map {
    let mut document = Map::new();
    document.insert("title", Value::String(title.into()));
    document.insert("category", Value::String(category.into()));
    document
}

fn embedded_config(adapter: &str) -> IndexConfig {
    IndexConfig {
        schema: parse_json(r#"{"title":"string","category":"string","embedding":"vector[2]"}"#)
            .unwrap(),
        embedding: Some(EmbeddingConfig {
            fields: vec![("embedding".into(), vec!["title".into()])],
            adapter: Some(AdapterSetting::Named(adapter.into())),
        }),
        ..IndexConfig::default()
    }
}

fn fill(engine: &Narsil, config: IndexConfig, documents: &[(&str, &str, &str)]) {
    engine.create_index(INDEX, config).unwrap();
    for (id, title, category) in documents {
        engine
            .insert(INDEX, document(title, category), Some(id))
            .unwrap();
    }
}

fn engine_holding(documents: &[(&str, &str, &str)]) -> Narsil {
    let engine = Narsil::new();
    fill(&engine, config(), documents);
    engine
}

fn word_vector(text: &str) -> Vec<f32> {
    match text.split_whitespace().any(|word| word == SEARCHED_WORD) {
        true => MATCHING_VECTOR.to_vec(),
        false => OTHER_VECTOR.to_vec(),
    }
}

fn word_embedding(
    on_query: impl Fn() -> narsil::Result<()> + Send + Sync + 'static,
) -> Arc<dyn narsil::EmbeddingAdapter> {
    Arc::new(EmbedWith {
        dimensions: MATCHING_VECTOR.len(),
        embed: move |input: &str| {
            if input == SEARCHED_WORD {
                on_query()?;
            }
            Ok(word_vector(input))
        },
    })
}

fn title_length_score(title: &str) -> f64 {
    title.chars().count() as f64
}

struct ExpectedPage {
    ids: Vec<String>,
    documents: Vec<Map>,
    count: u64,
    categories: BTreeMap<String, u64>,
}

fn expected_page(documents: &[(&str, &str, &str)]) -> ExpectedPage {
    let mut matching: Vec<&(&str, &str, &str)> = documents
        .iter()
        .filter(|(_, title, _)| title.split_whitespace().any(|word| word == SEARCHED_WORD))
        .collect();
    matching
        .sort_by(|left, right| title_length_score(right.1).total_cmp(&title_length_score(left.1)));
    let mut categories = BTreeMap::new();
    for (_, _, category) in &matching {
        *categories.entry((*category).to_string()).or_insert(0) += 1;
    }
    ExpectedPage {
        ids: matching
            .iter()
            .map(|(id, _, _)| (*id).to_string())
            .collect(),
        documents: matching
            .iter()
            .map(|(_, title, category)| document(title, category))
            .collect(),
        count: matching.len() as u64,
        categories,
    }
}

fn register_restoring(engine: &Arc<Narsil>, archive: Vec<u8>, restores: usize) -> Arc<AtomicUsize> {
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&calls);
    let restoring: Weak<Narsil> = Arc::downgrade(engine);
    engine
        .register_rerank_adapter(
            "restoring",
            Arc::new(RerankWith(move |_: &str, documents: &[String]| {
                if counted.fetch_add(1, Ordering::SeqCst) < restores {
                    restoring
                        .upgrade()
                        .unwrap()
                        .restore(INDEX, &mut archive.as_slice())?;
                }
                Ok(documents
                    .iter()
                    .map(|text| title_length_score(text))
                    .collect())
            })),
        )
        .unwrap();
    calls
}

fn reranked_search() -> QueryParams {
    QueryParams {
        term: Some(SEARCHED_WORD.into()),
        facets: Some(vec![("category".into(), FacetSpec::default())]),
        rerank: Some(RerankConfig {
            adapter: "restoring".into(),
            fields: vec!["title".into()],
            ..RerankConfig::default()
        }),
        ..QueryParams::default()
    }
}

fn require_restored_page(result: narsil::QueryResult) {
    let expected = expected_page(&RESTORED_DOCUMENTS);
    let ids: Vec<String> = result.hits.iter().map(|hit| hit.id.clone()).collect();
    assert_eq!(ids, expected.ids);
    let documents: Vec<Map> = result.hits.iter().map(|hit| hit.document.clone()).collect();
    assert_eq!(documents, expected.documents);
    assert_eq!(result.count, expected.count);
    let facets = result.facets.expect("the query asked for category facets");
    let [(field, categories)] = facets.as_slice() else {
        panic!("the query asked for one facet field, and the result holds {facets:?}");
    };
    assert_eq!(field, "category");
    let counted: BTreeMap<String, u64> = categories.values.iter().cloned().collect();
    assert_eq!(counted, expected.categories);
}

#[test]
fn a_reranked_query_whose_index_one_restore_replaces_returns_a_page_of_the_restored_index() {
    let source = engine_holding(&RESTORED_DOCUMENTS);
    let archive = snapshot_of(&source, INDEX);
    let target = Arc::new(engine_holding(&REPLACED_DOCUMENTS));
    let calls = register_restoring(&target, archive, 1);

    let result = target.query(INDEX, &reranked_search()).unwrap();

    require_restored_page(result);
    assert_eq!(calls.load(Ordering::SeqCst), RERANK_CALLS_WITH_ONE_RESTORE);
}

#[test]
fn a_reranked_query_refuses_with_worker_busy_once_a_restore_replaces_its_index_during_every_rerank_call()
 {
    let source = engine_holding(&RESTORED_DOCUMENTS);
    let archive = snapshot_of(&source, INDEX);
    let target = Arc::new(engine_holding(&REPLACED_DOCUMENTS));
    let calls = register_restoring(&target, archive, usize::MAX);

    let error = target
        .query(INDEX, &reranked_search())
        .expect_err("the query refuses once every rerank call restores its index");

    assert_eq!(error.code(), ErrorCode::WORKER_BUSY, "{error}");
    assert_eq!(calls.load(Ordering::SeqCst), RERANK_CALLS_BEFORE_REFUSAL);
    let restored = target.get(INDEX, "restored-current").unwrap();
    assert_eq!(
        restored,
        Some(document("slow river current water", "wetland"))
    );
}

#[test]
fn only_rerank_calls_that_a_restore_interrupted_count_toward_the_refusal_never_a_changed_embedding_adapter()
 {
    let source = Narsil::new();
    source
        .register_embedding_adapter("later", word_embedding(|| Ok(())))
        .unwrap();
    fill(&source, embedded_config("later"), &RESTORED_DOCUMENTS);
    let archive = snapshot_of(&source, INDEX);

    let target = Arc::new(Narsil::new());
    let embeddings = Arc::new(AtomicUsize::new(0));
    let restoring = Arc::downgrade(&target);
    let counted = Arc::clone(&embeddings);
    let restored_archive = archive.clone();
    target
        .register_embedding_adapter(
            "earlier",
            word_embedding(move || {
                counted.fetch_add(1, Ordering::SeqCst);
                restoring
                    .upgrade()
                    .unwrap()
                    .restore(INDEX, &mut restored_archive.as_slice())
            }),
        )
        .unwrap();
    let counted = Arc::clone(&embeddings);
    target
        .register_embedding_adapter(
            "later",
            word_embedding(move || {
                counted.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }),
        )
        .unwrap();
    fill(&target, embedded_config("earlier"), &REPLACED_DOCUMENTS);
    let calls = register_restoring(&target, archive, RERANK_CALLS_BEFORE_REFUSAL - 1);

    let result = target
        .query(
            INDEX,
            &QueryParams {
                vector: Some(VectorQuery {
                    field: "embedding".into(),
                    text: Some(SEARCHED_WORD.into()),
                    similarity: Some(SIMILARITY_FLOOR),
                    ..VectorQuery::default()
                }),
                document: Some(DocumentProjection::Fields {
                    include: None,
                    exclude: Some(vec!["embedding".into()]),
                }),
                ..reranked_search()
            },
        )
        .unwrap();

    require_restored_page(result);
    assert_eq!(calls.load(Ordering::SeqCst), RERANK_CALLS_BEFORE_REFUSAL);
    assert_eq!(
        embeddings.load(Ordering::SeqCst),
        QUERY_EMBEDDINGS_ACROSS_ONE_ADAPTER_CHANGE
    );
}
