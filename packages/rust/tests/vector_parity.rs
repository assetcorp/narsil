mod support;

use std::collections::HashMap;
use std::sync::Arc;

use narsil::{
    AdapterSetting, EmbeddingConfig, IndexConfig, Map, Narsil, Value, VectorPromotion, parse_json,
};
use support::adapters::{PARITY_EMBEDDING_ADAPTER, fixed_embedding, parity_rerank_adapters};
use support::conformance_root;
use support::parity::{
    DATASET_VECTOR_DIMENSION, DATASET_VECTOR_FIELD, ParitySpec, ReferenceExtras, apply_writes,
    conformance_searches, dataset_documents_with_vectors, dataset_vectors, engine_outcomes,
    load_documents, reference_outcomes_with, vector_value,
};
use support::parity_cases::{answered_count, index_config, query, require_same_outcomes};

const INDEX_NAME: &str = "bills";
const BRUTE_FORCE_THRESHOLD: u64 = 1_000_000;
const QUERIES_PER_SHAPE: usize = 6;
const REMOVED_NEIGHBOURS: usize = 3;
const UPDATED_WITH_VECTOR_ROW: usize = 17;
const UPDATED_BY_ADAPTER_ROW: usize = 42;
const EMBEDDED_UPDATE_SOURCE_ROW: usize = 4_242;

struct VectorQueryCase {
    text: String,
    vector: Vec<f32>,
}

fn dataset_queries() -> Vec<VectorQueryCase> {
    let path = conformance_root().join(".dataset/queries.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{} is unreadable: {error}", path.display()));
    let parsed = parse_json(&text).expect("the dataset queries hold JSON");
    parsed
        .pointer("vectorQueries")
        .and_then(Value::as_array)
        .expect("the dataset lists its vector queries")
        .iter()
        .map(|entry| VectorQueryCase {
            text: entry
                .pointer("text")
                .and_then(Value::as_str)
                .expect("a query text")
                .to_string(),
            vector: entry
                .pointer("vector")
                .and_then(Value::as_array)
                .expect("a query vector")
                .iter()
                .map(|element| element.as_f64().expect("a vector element") as f32)
                .collect(),
        })
        .collect()
}

fn with_vector(json: &str, vector: &[f32]) -> Value {
    let mut value = query(json);
    if let Some(Value::Object(clause)) = value.as_object_mut().and_then(|map| map.get_mut("vector"))
    {
        clause.insert("value", vector_value(vector));
    }
    value
}

fn with_term(mut value: Value, term: &str) -> Value {
    if let Some(map) = value.as_object_mut() {
        map.insert("term", Value::String(term.to_string()));
    }
    value
}

fn with_vector_text(json: &str, text: &str) -> Value {
    let mut value = query(json);
    if let Some(Value::Object(clause)) = value.as_object_mut().and_then(|map| map.get_mut("vector"))
    {
        clause.insert("text", Value::String(text.to_string()));
    }
    value
}

const CLAUSE: &str = r#""vector": {"field": "embedding"}"#;
const MATCHES_NOTHING: &str = r#"{"fields": {"title": {"notExists": true}}}"#;

fn shaped_queries(case: &VectorQueryCase) -> Vec<Value> {
    let vector = case.vector.as_slice();
    let term = case.text.as_str();
    let shapes = [
        format!("{{{CLAUSE}, \"limit\": 10}}"),
        format!("{{{CLAUSE}, \"limit\": 7, \"offset\": 5}}"),
        r#"{"vector": {"field": "embedding", "similarity": 0.45}, "limit": 50}"#.to_string(),
        r#"{"vector": {"field": "embedding", "metric": "dotProduct"}}"#.to_string(),
        r#"{"vector": {"field": "embedding", "metric": "euclidean"}, "limit": 5}"#.to_string(),
        format!("{{{CLAUSE}, \"mode\": \"hybrid\"}}"),
        format!("{{{CLAUSE}, \"mode\": \"vector\", \"limit\": 4, \"offset\": 9995}}"),
    ];
    let hybrid_shapes = [
        format!("{{{CLAUSE}}}"),
        format!("{{{CLAUSE}, \"limit\": 12, \"offset\": 3}}"),
        format!("{{{CLAUSE}, \"hybrid\": {{\"strategy\": \"linear\", \"alpha\": 0.3}}}}"),
        format!("{{{CLAUSE}, \"hybrid\": {{\"strategy\": \"linear\"}}, \"limit\": 20}}"),
        format!("{{{CLAUSE}, \"hybrid\": {{\"k\": 10}}}}"),
        format!("{{{CLAUSE}, \"hybrid\": {{\"depth\": 50}}, \"limit\": 10, \"offset\": 10}}"),
        format!(
            "{{{CLAUSE}, \"hybrid\": {{\"depth\": 25, \"strategy\": \"linear\", \"alpha\": 0.8}}}}"
        ),
        format!("{{{CLAUSE}, \"minScore\": 0.02, \"limit\": 30}}"),
        format!("{{{CLAUSE}, \"mode\": \"vector\"}}"),
        format!("{{{CLAUSE}, \"mode\": \"fulltext\"}}"),
        format!("{{{CLAUSE}, \"fields\": [\"title\"], \"termMatch\": \"all\"}}"),
    ];
    let rerank_shapes = [
        format!(
            "{{{CLAUSE}, \"rerank\": {{\"adapter\": \"length\", \"fields\": [\"title\"], \"query\": \"water\"}}}}"
        ),
        format!(
            "{{{CLAUSE}, \"rerank\": {{\"adapter\": \"length\", \"fields\": [\"title\", \"summary\"], \"window\": 5}}, \"limit\": 8, \"offset\": 2}}"
        ),
        format!(
            "{{{CLAUSE}, \"hybrid\": {{\"depth\": 40}}, \"rerank\": {{\"adapter\": \"length\", \"fields\": [\"summary\"], \"window\": 30}}}}"
        ),
    ];
    let mut queries: Vec<Value> = shapes
        .iter()
        .map(|shape| with_vector(shape, vector))
        .collect();
    queries.extend(
        hybrid_shapes
            .iter()
            .map(|shape| with_term(with_vector(shape, vector), term)),
    );
    queries.push(with_vector(&rerank_shapes[0], vector));
    queries.extend(
        rerank_shapes[1..]
            .iter()
            .map(|shape| with_term(with_vector(shape, vector), term)),
    );
    queries.push(with_vector_text(&format!("{{{CLAUSE}}}"), term));
    queries.push(with_term(
        with_vector_text(&format!("{{{CLAUSE}, \"limit\": 15}}"), term),
        term,
    ));
    queries.push(with_vector_text(
        &format!(
            "{{{CLAUSE}, \"rerank\": {{\"adapter\": \"length\", \"fields\": [\"title\"]}}, \"limit\": 6}}"
        ),
        term,
    ));
    queries.push(with_term(
        query(
            r#"{"rerank": {"adapter": "length", "fields": ["title", "summary"], "window": 20}, "limit": 10, "offset": 3}"#,
        ),
        term,
    ));
    queries.extend(
        pinned_shapes()
            .iter()
            .map(|shape| with_term(with_vector(shape, vector), term)),
    );
    queries
}

const PINS: &str = r#""pinned": [{"docId": "train-00007", "position": 2}, {"docId": "missing-document", "position": 0}, {"docId": "train-00000", "position": 0}, {"docId": "train-00007", "position": 0}, {"docId": "train-00003", "position": 400}]"#;

fn pinned_shapes() -> [String; 4] {
    [
        format!("{{{CLAUSE}, {PINS}, \"limit\": 12}}"),
        format!(
            "{{{CLAUSE}, {PINS}, \"hybrid\": {{\"strategy\": \"linear\", \"alpha\": 0.6}}, \"limit\": 8, \"offset\": 1}}"
        ),
        format!("{{{CLAUSE}, {PINS}, \"hybrid\": {{\"depth\": 30}}, \"limit\": 10}}"),
        format!(
            "{{{CLAUSE}, {PINS}, \"rerank\": {{\"adapter\": \"length\", \"fields\": [\"title\"], \"window\": 10}}, \"limit\": 9, \"offset\": 1}}"
        ),
    ]
}

fn hostile_queries(case: &VectorQueryCase) -> Vec<Value> {
    let vector = case.vector.as_slice();
    let short = &case.vector[..3];
    let term = case.text.as_str();
    let mut queries = vec![
        with_vector(&format!("{{{CLAUSE}}}"), short),
        with_vector(r#"{"vector": {"field": "title"}}"#, vector),
        with_vector(r#"{"vector": {"field": "missing"}}"#, vector),
        query(r#"{"mode": "vector"}"#),
        query(r#"{"mode": "hybrid", "term": "water"}"#),
        query(r#"{"mode": "vector", "vector": {"field": "embedding"}}"#),
        with_vector(
            &format!("{{{CLAUSE}, \"limit\": 9000, \"offset\": 1001}}"),
            vector,
        ),
        with_vector(&format!("{{{CLAUSE}, \"limit\": 0}}"), vector),
        with_vector(
            r#"{"vector": {"field": "embedding", "similarity": 2}}"#,
            vector,
        ),
        with_vector(
            r#"{"vector": {"field": "embedding", "efSearch": 1}}"#,
            vector,
        ),
        with_vector(
            r#"{"vector": {"field": "embedding", "efSearch": 10000}}"#,
            vector,
        ),
        with_vector(
            r#"{"vector": {"field": "embedding", "efSearch": 0}}"#,
            vector,
        ),
        with_vector(
            r#"{"vector": {"field": "embedding", "efSearch": 10001}}"#,
            vector,
        ),
        with_term(
            with_vector(
                r#"{"vector": {"field": "embedding", "efSearch": 10001}}"#,
                vector,
            ),
            term,
        ),
        with_vector(
            r#"{"vector": {"field": "embedding", "oversample": 0}}"#,
            vector,
        ),
        with_vector(
            r#"{"vector": {"field": "embedding", "oversample": 1000}}"#,
            vector,
        ),
        with_vector(
            r#"{"vector": {"field": "embedding", "oversample": 1000000000}}"#,
            vector,
        ),
        with_vector(
            &format!("{{{CLAUSE}, \"filters\": {MATCHES_NOTHING}}}"),
            vector,
        ),
        with_vector(
            &format!(
                "{{\"vector\": {{\"field\": \"embedding\", \"efSearch\": 0}}, \"filters\": {MATCHES_NOTHING}}}"
            ),
            vector,
        ),
        with_vector(
            &format!(
                "{{\"vector\": {{\"field\": \"embedding\", \"oversample\": 0.5}}, \"filters\": {MATCHES_NOTHING}}}"
            ),
            vector,
        ),
        with_term(
            with_vector(
                &format!(
                    "{{\"vector\": {{\"field\": \"embedding\", \"efSearch\": 10001}}, \"filters\": {MATCHES_NOTHING}}}"
                ),
                vector,
            ),
            term,
        ),
        with_term(
            with_vector(
                r#"{"vector": {"field": "embedding", "efSearch": 0}, "hybrid": {"depth": 40}}"#,
                vector,
            ),
            term,
        ),
        with_term(
            with_vector(
                r#"{"vector": {"field": "embedding", "oversample": 0.5}, "hybrid": {"depth": 0}}"#,
                vector,
            ),
            term,
        ),
        with_vector(
            r#"{"vector": {"field": "embedding", "text": "water"}}"#,
            vector,
        ),
        with_vector_text(&format!("{{{CLAUSE}}}"), ""),
        with_vector_text(
            &format!("{{{CLAUSE}}}"),
            "a text that the adapter never saw",
        ),
    ];
    let hybrid_errors = [
        r#"{"hybrid": {"k": 0}}"#,
        r#"{"hybrid": {"k": 1.5}}"#,
        r#"{"hybrid": {"alpha": 1.5}}"#,
        r#"{"hybrid": {"alpha": -0.1}}"#,
        r#"{"hybrid": {"depth": 0}}"#,
        r#"{"hybrid": {"depth": 10001}}"#,
        r#"{"hybrid": {"depth": 10}, "offset": 10}"#,
        r#"{"hybrid": {"depth": 10000}, "limit": 10, "offset": 9995}"#,
    ];
    queries.extend(hybrid_errors.iter().map(|json| {
        let mut value = with_term(with_vector(json, vector), term);
        if let Some(map) = value.as_object_mut() {
            let mut clause = Map::new();
            clause.insert("field", Value::String(DATASET_VECTOR_FIELD.to_string()));
            clause.insert("value", vector_value(vector));
            map.insert("vector", Value::Object(clause));
        }
        value
    }));
    let rerank_errors = [
        r#"{"adapter": "", "fields": ["title"]}"#,
        r#"{"adapter": "unregistered", "fields": ["title"]}"#,
        r#"{"adapter": "length", "fields": []}"#,
        r#"{"adapter": "length", "fields": ["embedding"]}"#,
        r#"{"adapter": "length", "fields": ["missing"]}"#,
        r#"{"adapter": "length", "fields": ["title", "title"]}"#,
        r#"{"adapter": "length", "fields": ["title"], "window": 0}"#,
        r#"{"adapter": "length", "fields": ["title"], "window": 101}"#,
        r#"{"adapter": "length", "fields": ["title"], "query": "   "}"#,
        r#"{"adapter": "broken", "fields": ["title"]}"#,
        r#"{"adapter": "nan", "fields": ["title"]}"#,
        r#"{"adapter": "short", "fields": ["title"]}"#,
    ];
    for rerank in rerank_errors {
        let mut value = with_term(with_vector(&format!("{{{CLAUSE}}}"), vector), term);
        if let Some(map) = value.as_object_mut() {
            map.insert("rerank", parse_json(rerank).expect("the rerank is JSON"));
        }
        queries.push(value);
    }
    queries.push(with_vector(
        &format!(
            "{{{CLAUSE}, \"rerank\": {{\"adapter\": \"unregistered\", \"fields\": [\"title\"], \"query\": \"water\"}}, \"limit\": 0}}"
        ),
        vector,
    ));
    queries.push(with_vector(
        &format!(
            "{{{CLAUSE}, \"rerank\": {{\"adapter\": \"broken\", \"fields\": [\"title\"], \"query\": \"water\"}}, \"offset\": 9990}}"
        ),
        vector,
    ));
    queries.push(with_term(
        with_vector(
            &format!(
                "{{{CLAUSE}, \"hybrid\": {{\"depth\": 30}}, \"rerank\": {{\"adapter\": \"length\", \"fields\": [\"title\"], \"window\": 40}}}}"
            ),
            vector,
        ),
        term,
    ));
    queries.push(query(
        r#"{"term": "   ", "rerank": {"adapter": "length", "fields": ["title"]}}"#,
    ));
    queries
}

fn document_id(documents: &[Map], row: usize) -> String {
    documents[row]
        .get("id")
        .and_then(Value::as_str)
        .expect("an ID")
        .to_string()
}

struct VectorWrites {
    removals: Vec<String>,
    updates: Vec<(String, Map)>,
    embedded: (String, Vec<f32>),
}

fn chosen_vector_writes(documents: &[Map], first_query: &VectorQueryCase) -> VectorWrites {
    let searches = conformance_searches();
    let removals: Vec<String> = searches
        .pointer("vector.queries")
        .and_then(Value::as_array)
        .and_then(|queries| queries.first())
        .and_then(|first| first.pointer("neighbours"))
        .and_then(Value::as_array)
        .expect("the first vector search lists its neighbours")
        .iter()
        .take(REMOVED_NEIGHBOURS)
        .map(|neighbour| {
            neighbour
                .pointer("id")
                .and_then(Value::as_str)
                .expect("a neighbour ID")
                .to_string()
        })
        .collect();
    let vectors = dataset_vectors();
    let mut with_vector = documents[UPDATED_WITH_VECTOR_ROW].clone();
    with_vector.insert(
        "title",
        Value::String("Water resources, rewritten with a new vector".into()),
    );
    with_vector.insert(DATASET_VECTOR_FIELD, vector_value(&first_query.vector));
    let mut by_adapter = documents[UPDATED_BY_ADAPTER_ROW].clone();
    by_adapter.remove(DATASET_VECTOR_FIELD);
    let title = "Water resources development, embedded by the adapter";
    let summary = "Directs the Secretary of the Army to repair levees and dams.";
    by_adapter.insert("title", Value::String(title.into()));
    by_adapter.insert("summary", Value::String(summary.into()));
    let updates = vec![
        (document_id(documents, UPDATED_WITH_VECTOR_ROW), with_vector),
        (document_id(documents, UPDATED_BY_ADAPTER_ROW), by_adapter),
    ];
    let embedded = (
        format!("{title}\n{summary}"),
        vectors[EMBEDDED_UPDATE_SOURCE_ROW].clone(),
    );
    VectorWrites {
        removals,
        updates,
        embedded,
    }
}

fn reference_config() -> Map {
    parse_json(&format!(
        r#"{{"vectorPromotion": {{"threshold": {BRUTE_FORCE_THRESHOLD}}}, "embedding": {{"adapter": "{PARITY_EMBEDDING_ADAPTER}", "fields": {{"embedding": ["title", "summary"]}}}}}}"#
    ))
    .expect("the config is JSON")
    .as_object()
    .expect("the config is an object")
    .clone()
}

fn crate_config(searches: &Value) -> IndexConfig {
    IndexConfig {
        vector_promotion: Some(VectorPromotion {
            threshold: Some(BRUTE_FORCE_THRESHOLD),
            ..VectorPromotion::default()
        }),
        embedding: Some(EmbeddingConfig {
            fields: vec![(
                DATASET_VECTOR_FIELD.to_string(),
                vec!["title".to_string(), "summary".to_string()],
            )],
            adapter: Some(AdapterSetting::Named(PARITY_EMBEDDING_ADAPTER.to_string())),
        }),
        ..index_config(searches)
    }
}

#[test]
fn vector_hybrid_and_reranked_queries_match_the_reference_after_writes() {
    let searches = conformance_searches();
    let documents = dataset_documents_with_vectors();
    let cases = dataset_queries();
    let VectorWrites {
        removals,
        updates,
        embedded,
    } = chosen_vector_writes(&documents, &cases[0]);
    let mut queries: Vec<Value> = cases
        .iter()
        .take(QUERIES_PER_SHAPE)
        .flat_map(shaped_queries)
        .collect();
    queries.extend(hostile_queries(&cases[0]));
    let mut embeddings: Vec<(String, Vec<f32>)> = cases
        .iter()
        .take(QUERIES_PER_SHAPE)
        .map(|case| (case.text.clone(), case.vector.clone()))
        .collect();
    embeddings.push(embedded);
    let spec = ParitySpec {
        index: INDEX_NAME.to_string(),
        config: reference_config(),
        removals,
        updates,
        synonym_updates: Vec::new(),
        queries,
    };
    let extras = ReferenceExtras {
        vectors: true,
        embeddings: embeddings.clone(),
        rerank_adapters: true,
    };
    let wanted = reference_outcomes_with(&spec, &extras);

    let engine = Narsil::new();
    let table: HashMap<String, Vec<f32>> = embeddings.into_iter().collect();
    engine
        .register_embedding_adapter(
            PARITY_EMBEDDING_ADAPTER,
            Arc::new(fixed_embedding(DATASET_VECTOR_DIMENSION, table)),
        )
        .expect("the embedding adapter registers");
    for (name, adapter) in parity_rerank_adapters() {
        engine
            .register_rerank_adapter(name, Arc::from(adapter))
            .expect("the rerank adapter registers");
    }
    load_documents(
        &engine,
        &spec,
        crate_config(&searches),
        &documents,
        &mut |_| {},
    );
    apply_writes(&engine, &spec);
    let found = engine_outcomes(&engine, &spec);

    require_same_outcomes(&spec, &found, &wanted);
    assert!(
        answered_count(&wanted) > spec.queries.len() / 2,
        "most queries return hits, so the comparison covers ranking and not only empty pages"
    );
}
