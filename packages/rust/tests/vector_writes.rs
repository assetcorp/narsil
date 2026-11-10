mod support;

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use narsil::{
    AdapterError, AdapterSetting, EmbeddingAdapter, EmbeddingConfig, ErrorCode, IndexConfig, Map,
    Narsil, Quantization, QueryParams, RerankConfig, Value, VectorPromotion, VectorQuery,
    parse_json,
};
use support::adapters::{EmbedWith, RerankWith};

const INDEX: &str = "notes";
const FIELD: &str = "embedding";
const DIMENSION: usize = 8;
const BRUTE_FORCE_THRESHOLD: u64 = 1_000_000;
const GRAPH_THRESHOLD: u64 = 256;
const SCORE_TOLERANCE: f64 = 1e-4;
const FLOAT32_OVERFLOW: f64 = 1e39;
const RERANK_TIMEOUT: Duration = Duration::from_secs(30);
const BLOCKED_ADAPTER_SLEEP: Duration = Duration::from_secs(45);
const SEARCHES_BESIDE_A_BLOCKED_RERANK: usize = 200;
const LONGEST_UNBLOCKED_SEARCH_RUN: Duration = Duration::from_secs(10);

fn vector_of(seed: u64) -> Vec<f32> {
    let mut state = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15).wrapping_add(1);
    (0..DIMENSION)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            ((state % 2_000_001) as f64 / 1_000_000.0 - 1.0) as f32
        })
        .collect()
}

fn as_value(vector: &[f32]) -> Value {
    Value::Array(
        vector
            .iter()
            .map(|element| Value::Number(f64::from(*element)))
            .collect(),
    )
}

fn document(id: &str, title: &str, vector: Option<Value>) -> Map {
    let mut map = Map::new();
    map.insert("id", Value::String(id.to_string()));
    map.insert("title", Value::String(title.to_string()));
    if let Some(vector) = vector {
        map.insert(FIELD, vector);
    }
    map
}

fn stored_vector(engine: &Narsil, id: &str) -> Option<Vec<f32>> {
    let found = engine.get(INDEX, id).expect("the read succeeds")?;
    let Some(Value::Array(items)) = found.get(FIELD) else {
        return None;
    };
    Some(
        items
            .iter()
            .map(|item| item.as_f64().expect("a number") as f32)
            .collect(),
    )
}

fn cosine(left: &[f32], right: &[f32]) -> f64 {
    let dot: f64 = left
        .iter()
        .zip(right)
        .map(|(a, b)| f64::from(*a) * f64::from(*b))
        .sum();
    let norm = |vector: &[f32]| {
        vector
            .iter()
            .map(|a| f64::from(*a) * f64::from(*a))
            .sum::<f64>()
            .sqrt()
    };
    dot / (norm(left) * norm(right))
}

fn schema() -> Value {
    parse_json(&format!(
        r#"{{"title": "string", "{FIELD}": "vector[{DIMENSION}]"}}"#
    ))
    .expect("the schema is JSON")
}

fn config(threshold: u64) -> IndexConfig {
    IndexConfig {
        schema: schema(),
        vector_promotion: Some(VectorPromotion {
            threshold: Some(threshold),
            ..VectorPromotion::default()
        }),
        ..IndexConfig::default()
    }
}

fn vector_query(vector: &[f32], limit: usize) -> QueryParams {
    QueryParams {
        vector: Some(VectorQuery {
            field: FIELD.to_string(),
            value: Some(vector.to_vec()),
            ..VectorQuery::default()
        }),
        limit: Some(limit),
        ..QueryParams::default()
    }
}

fn code_of<T: std::fmt::Debug>(result: narsil::Result<T>) -> ErrorCode {
    result.expect_err("the engine refuses the call").code()
}

fn top_ids(engine: &Narsil, vector: &[f32], limit: usize) -> Vec<String> {
    engine
        .query(INDEX, &vector_query(vector, limit))
        .expect("the search succeeds")
        .hits
        .into_iter()
        .map(|hit| hit.id)
        .collect()
}

#[test]
fn a_refused_vector_write_leaves_documents_and_vectors_as_they_were() {
    let engine = Narsil::new();
    engine
        .create_index(INDEX, config(BRUTE_FORCE_THRESHOLD))
        .expect("the index is created");
    let kept = vector_of(1);
    engine
        .insert(
            INDEX,
            document("kept", "kept note", Some(as_value(&kept))),
            None,
        )
        .expect("a valid vector is stored");

    let short = engine.insert(
        INDEX,
        document("short", "short", Some(as_value(&kept[..3]))),
        None,
    );
    let error = short.expect_err("a short vector is refused");
    assert_eq!(error.code(), ErrorCode::VECTOR_DIMENSION_MISMATCH);
    assert_eq!(
        error.message(),
        format!("Vector dimension mismatch for field \"{FIELD}\": expected {DIMENSION}, got 3")
    );
    let mut with_text = as_value(&kept);
    if let Value::Array(items) = &mut with_text {
        items[2] = Value::String("0.5".into());
    }
    let mut with_nan = as_value(&kept);
    if let Value::Array(items) = &mut with_nan {
        items[4] = Value::Number(f64::NAN);
    }
    let mut overflowing = as_value(&kept);
    if let Value::Array(items) = &mut overflowing {
        items[0] = Value::Number(FLOAT32_OVERFLOW);
    }
    for (id, bad) in [
        ("text", with_text.clone()),
        ("nan", with_nan.clone()),
        ("overflow", overflowing.clone()),
    ] {
        assert_eq!(
            code_of(engine.insert(INDEX, document(id, id, Some(bad)), None)),
            ErrorCode::DOC_VALIDATION_FAILED,
            "the engine refuses the {id} vector"
        );
        assert!(engine.get(INDEX, id).expect("the read succeeds").is_none());
    }

    for bad in [with_text, with_nan, overflowing, as_value(&kept[..5])] {
        let refused = engine.update(INDEX, "kept", document("kept", "rewritten", Some(bad)));
        assert!(refused.is_err(), "the engine refuses the update");
        assert_eq!(stored_vector(&engine, "kept"), Some(kept.clone()));
        let stored = engine
            .get(INDEX, "kept")
            .expect("the read succeeds")
            .expect("the document stays");
        assert_eq!(
            stored.get("title"),
            Some(&Value::String("kept note".into()))
        );
    }
    assert_eq!(top_ids(&engine, &kept, 10), vec!["kept".to_string()]);

    assert_eq!(
        code_of(engine.update(
            INDEX,
            "absent",
            document("absent", "absent", Some(as_value(&kept[..2])))
        )),
        ErrorCode::VECTOR_DIMENSION_MISMATCH
    );
    assert_eq!(
        code_of(engine.update(
            INDEX,
            "absent",
            document("absent", "absent", Some(as_value(&kept)))
        )),
        ErrorCode::DOC_NOT_FOUND
    );

    let batch = engine
        .insert_batch(
            INDEX,
            vec![
                document("b1", "first", Some(as_value(&vector_of(2)))),
                document("b2", "second", Some(as_value(&kept[..4]))),
                document("b3", "third", Some(as_value(&vector_of(3)))),
            ],
        )
        .expect("the batch completes");
    let refused: Vec<(&str, ErrorCode)> = batch
        .failed
        .iter()
        .map(|failure| (failure.doc_id.as_str(), failure.error.code()))
        .collect();
    assert_eq!(refused, vec![("b2", ErrorCode::VECTOR_DIMENSION_MISMATCH)]);
    assert!(stored_vector(&engine, "b2").is_none());
    assert_eq!(top_ids(&engine, &vector_of(3), 1), vec!["b3".to_string()]);

    let mut infinite_query = kept.clone();
    infinite_query[1] = f32::INFINITY;
    assert_eq!(
        code_of(engine.query(INDEX, &vector_query(&infinite_query, 5))),
        ErrorCode::DOC_VALIDATION_FAILED
    );

    engine
        .remove(INDEX, "kept")
        .expect("the document is removed");
    assert!(!top_ids(&engine, &kept, 10).contains(&"kept".to_string()));
    assert_eq!(
        code_of(engine.remove(INDEX, "kept")),
        ErrorCode::DOC_NOT_FOUND
    );
}

fn scripted_embedding() -> Arc<dyn EmbeddingAdapter> {
    Arc::new(EmbedWith {
        dimensions: DIMENSION,
        embed: |input: &str| match input {
            "nan" => {
                let mut vector = vector_of(9);
                vector[3] = f32::NAN;
                Ok(vector)
            }
            "infinite" => {
                let mut vector = vector_of(9);
                vector[5] = f32::NEG_INFINITY;
                Ok(vector)
            }
            "short" => Ok(vector_of(9)[..DIMENSION - 1].to_vec()),
            "failing" => Err(AdapterError::from("embedding service unavailable")),
            "panicking" => panic!("the embedding model crashed"),
            other => Ok(vector_of(other.len() as u64)),
        },
    })
}

#[test]
fn a_broken_embedding_adapter_refuses_the_write_and_keeps_the_index_whole() {
    let engine = Narsil::new();
    let adapter = scripted_embedding();
    engine
        .create_index(
            INDEX,
            IndexConfig {
                embedding: Some(EmbeddingConfig {
                    fields: vec![(FIELD.to_string(), vec!["title".to_string()])],
                    adapter: Some(AdapterSetting::Instance(adapter)),
                }),
                ..config(BRUTE_FORCE_THRESHOLD)
            },
        )
        .expect("the index is created");
    engine
        .insert(INDEX, document("good", "a good title", None), None)
        .expect("the adapter fills the vector");
    assert_eq!(
        stored_vector(&engine, "good"),
        Some(vector_of("a good title".len() as u64))
    );

    let cases = [
        ("nan", ErrorCode::EMBEDDING_FAILED),
        ("infinite", ErrorCode::EMBEDDING_FAILED),
        ("short", ErrorCode::EMBEDDING_DIMENSION_MISMATCH),
        ("failing", ErrorCode::EMBEDDING_FAILED),
        ("panicking", ErrorCode::EMBEDDING_FAILED),
    ];
    for (title, code) in cases {
        let id = format!("doc-{title}");
        assert_eq!(
            code_of(engine.insert(INDEX, document(&id, title, None), None)),
            code,
            "inserting a document titled {title}"
        );
        assert!(engine.get(INDEX, &id).expect("the read succeeds").is_none());
        assert_eq!(
            code_of(engine.update(INDEX, "good", document("good", title, None))),
            code,
            "updating to the title {title}"
        );
        assert_eq!(
            stored_vector(&engine, "good"),
            Some(vector_of("a good title".len() as u64))
        );
        let text_query = QueryParams {
            vector: Some(VectorQuery {
                field: FIELD.to_string(),
                text: Some(title.to_string()),
                ..VectorQuery::default()
            }),
            ..QueryParams::default()
        };
        assert_eq!(code_of(engine.query(INDEX, &text_query)), code);
    }

    let batch = engine
        .insert_batch(
            INDEX,
            vec![
                document("first", "first title", None),
                document("second", "nan", None),
                document("third", "third title", None),
            ],
        )
        .expect("the batch completes");
    let refused: Vec<(&str, ErrorCode)> = batch
        .failed
        .iter()
        .map(|failure| (failure.doc_id.as_str(), failure.error.code()))
        .collect();
    assert_eq!(
        refused,
        vec![
            ("first", ErrorCode::EMBEDDING_FAILED),
            ("second", ErrorCode::EMBEDDING_FAILED),
            ("third", ErrorCode::EMBEDDING_FAILED),
        ],
        "an unusable vector fails the adapter call for the whole chunk, as every Narsil engine does"
    );
    for id in ["first", "second", "third"] {
        assert!(engine.get(INDEX, id).expect("the read succeeds").is_none());
    }

    let crashed = engine
        .insert_batch(
            INDEX,
            vec![
                document("fourth", "fourth title", None),
                document("fifth", "panicking", None),
            ],
        )
        .expect("the batch completes");
    assert_eq!(crashed.failed.len(), 2, "a crash fails the whole chunk");
    assert!(
        engine
            .get(INDEX, "fourth")
            .expect("the read succeeds")
            .is_none()
    );
    engine
        .insert(INDEX, document("after", "after the crash", None), None)
        .expect("the engine keeps working after a crash");
    assert_eq!(
        top_ids(&engine, &vector_of(15), 1),
        vec!["after".to_string()]
    );
}

#[test]
fn searches_beside_writes_return_whole_documents_with_correct_scores() {
    let engine = Narsil::new();
    engine
        .create_index(INDEX, config(GRAPH_THRESHOLD))
        .expect("the index is created");
    let seeded: Vec<Map> = (0..1_500u64)
        .map(|n| {
            document(
                &format!("doc-{n}"),
                &format!("water bill {n}"),
                Some(as_value(&vector_of(n))),
            )
        })
        .collect();
    let seeded_result = engine
        .insert_batch(INDEX, seeded)
        .expect("the batch completes");
    assert!(seeded_result.failed.is_empty());
    let writing = AtomicBool::new(true);
    std::thread::scope(|scope| {
        scope.spawn(|| {
            for n in 1_500..2_500u64 {
                let id = format!("doc-{n}");
                engine
                    .insert(
                        INDEX,
                        document(
                            &id,
                            &format!("water bill {n}"),
                            Some(as_value(&vector_of(n))),
                        ),
                        None,
                    )
                    .expect("the insert succeeds");
                let old = n - 1_000;
                if old % 3 == 0 {
                    engine
                        .remove(INDEX, &format!("doc-{old}"))
                        .expect("the removal succeeds");
                } else if old % 3 == 1 {
                    engine
                        .update(
                            INDEX,
                            &format!("doc-{old}"),
                            document(
                                &format!("doc-{old}"),
                                &format!("water levee {old}"),
                                Some(as_value(&vector_of(old))),
                            ),
                        )
                        .expect("the update succeeds");
                }
            }
            writing.store(false, Ordering::Release);
        });
        for reader in 0..4u64 {
            let engine = &engine;
            let writing = &writing;
            scope.spawn(move || {
                let mut round = 0u64;
                while writing.load(Ordering::Acquire) || round < 20 {
                    let target = vector_of(10_000 + reader * 1_000 + round);
                    let mut params = vector_query(&target, 20);
                    if round % 2 == 1 {
                        params.term = Some("water".into());
                    }
                    let result = engine.query(INDEX, &params).expect("the search succeeds");
                    for hit in &result.hits {
                        let number: u64 = hit
                            .id
                            .strip_prefix("doc-")
                            .and_then(|n| n.parse().ok())
                            .expect("a document ID");
                        let Some(Value::Array(stored)) = hit.document.get(FIELD) else {
                            panic!("the hit {} lacks its vector", hit.id);
                        };
                        let stored: Vec<f32> = stored
                            .iter()
                            .map(|item| item.as_f64().expect("a number") as f32)
                            .collect();
                        assert_eq!(stored, vector_of(number), "the vector of {}", hit.id);
                        assert!(hit.document.get("title").is_some());
                        if round % 2 == 0 {
                            let wanted = cosine(&target, &stored);
                            let score = hit.score.expect("a score");
                            assert!(
                                (score - wanted).abs() < SCORE_TOLERANCE,
                                "{} scores {score}, the oracle {wanted}",
                                hit.id
                            );
                        }
                    }
                    round += 1;
                }
            });
        }
    });
    for n in 500..1_500u64 {
        let present = engine
            .get(INDEX, &format!("doc-{n}"))
            .expect("the read succeeds")
            .is_some();
        assert_eq!(present, n % 3 != 0, "doc-{n}");
    }
}

#[test]
fn a_graph_search_finds_the_true_neighbours_after_upkeep() {
    let engine = Narsil::new();
    engine
        .create_index(INDEX, config(GRAPH_THRESHOLD))
        .expect("the index is created");
    let count = 3_000u64;
    let documents: Vec<Map> = (0..count)
        .map(|n| document(&format!("doc-{n}"), "note", Some(as_value(&vector_of(n)))))
        .collect();
    assert!(
        engine
            .insert_batch(INDEX, documents)
            .expect("inserted")
            .failed
            .is_empty()
    );
    for n in (0..count).step_by(5) {
        engine.remove(INDEX, &format!("doc-{n}")).expect("removed");
    }
    let before = engine.vector_maintenance_status(INDEX).expect("a status");
    assert_eq!(before.len(), 1);
    assert!(before[0].tombstone_ratio > 0.0, "removals leave tombstones");
    engine
        .compact_vectors(INDEX, Some(FIELD))
        .expect("compacted");
    engine.optimize_vectors(INDEX, None).expect("optimised");
    let after = engine.vector_maintenance_status(INDEX).expect("a status");
    assert_eq!(after[0].tombstone_ratio, 0.0);
    assert!(!after[0].building);
    assert_eq!(
        code_of(engine.compact_vectors(INDEX, Some("title"))),
        ErrorCode::INDEX_NOT_FOUND
    );

    let live: Vec<(String, Vec<f32>)> = (0..count)
        .filter(|n| n % 5 != 0)
        .map(|n| (format!("doc-{n}"), vector_of(n)))
        .collect();
    let mut found_total = 0usize;
    let queries = 40u64;
    for q in 0..queries {
        let target = vector_of(50_000 + q);
        let mut oracle: Vec<(f64, &str)> = live
            .iter()
            .map(|(id, vector)| (cosine(&target, vector), id.as_str()))
            .collect();
        oracle.sort_by(|a, b| b.0.total_cmp(&a.0));
        let wanted: HashSet<&str> = oracle.iter().take(10).map(|(_, id)| *id).collect();
        let hits = top_ids(&engine, &target, 10);
        assert!(
            hits.iter()
                .all(|id| live.iter().any(|(live_id, _)| live_id == id))
        );
        found_total += hits
            .iter()
            .filter(|id| wanted.contains(id.as_str()))
            .count();
    }
    let recall = found_total as f64 / (queries as f64 * 10.0);
    assert!(recall >= 0.9, "the graph recall is {recall}");
}

#[test]
fn a_blocked_rerank_adapter_times_out_while_other_searches_go_on() {
    let engine = Narsil::new();
    engine
        .create_index(INDEX, config(BRUTE_FORCE_THRESHOLD))
        .expect("the index is created");
    let documents: Vec<Map> = (0..300u64)
        .map(|n| {
            document(
                &format!("doc-{n}"),
                &format!("water bill {n}"),
                Some(as_value(&vector_of(n))),
            )
        })
        .collect();
    assert!(
        engine
            .insert_batch(INDEX, documents)
            .expect("inserted")
            .failed
            .is_empty()
    );
    engine
        .register_rerank_adapter(
            "slow",
            Arc::new(RerankWith(|_: &str, documents: &[String]| {
                std::thread::sleep(BLOCKED_ADAPTER_SLEEP);
                Ok(vec![0.0; documents.len()])
            })),
        )
        .expect("registered");
    engine
        .register_rerank_adapter(
            "crashing",
            Arc::new(RerankWith(
                |_: &str, _: &[String]| -> Result<Vec<f64>, AdapterError> {
                    panic!("the reranker crashed")
                },
            )),
        )
        .expect("registered");
    let reranked = |adapter: &str| QueryParams {
        term: Some("water".into()),
        rerank: Some(RerankConfig {
            adapter: adapter.to_string(),
            fields: vec!["title".into()],
            ..RerankConfig::default()
        }),
        ..QueryParams::default()
    };
    let crashed = engine
        .query(INDEX, &reranked("crashing"))
        .expect_err("a crash is refused");
    assert_eq!(crashed.code(), ErrorCode::RERANK_FAILED);
    assert_eq!(
        crashed.message(),
        "Rerank adapter \"crashing\" failed: the reranker crashed"
    );

    std::thread::scope(|scope| {
        let blocked = scope.spawn(|| {
            let started = Instant::now();
            let error = engine
                .query(INDEX, &reranked("slow"))
                .expect_err("the engine gives up on the adapter");
            (error, started.elapsed())
        });
        let started = Instant::now();
        for n in 0..SEARCHES_BESIDE_A_BLOCKED_RERANK as u64 {
            let ids = top_ids(&engine, &vector_of(n), 1);
            assert_eq!(ids, vec![format!("doc-{n}")]);
        }
        engine
            .insert(
                INDEX,
                document("late", "late note", Some(as_value(&vector_of(777_777)))),
                None,
            )
            .expect("a write goes on beside the blocked rerank");
        assert!(started.elapsed() < LONGEST_UNBLOCKED_SEARCH_RUN);
        let (error, waited) = blocked.join().expect("the blocked search returns");
        assert_eq!(error.code(), ErrorCode::RERANK_FAILED);
        assert_eq!(
            error.message(),
            "Rerank adapter \"slow\" did not answer within 30000 ms, so the engine cancelled the call"
        );
        assert!(waited >= RERANK_TIMEOUT && waited < BLOCKED_ADAPTER_SLEEP);
    });
    assert_eq!(
        top_ids(&engine, &vector_of(777_777), 1),
        vec!["late".to_string()]
    );
}

#[test]
fn a_renamed_adapter_moves_every_index_that_gives_its_name() {
    let engine = Narsil::new();
    let named = |seed_offset: u64, dimensions: usize| {
        Arc::new(EmbedWith {
            dimensions,
            embed: move |input: &str| Ok(vector_of(input.len() as u64 + seed_offset)),
        })
    };
    let embedding_config = || IndexConfig {
        embedding: Some(EmbeddingConfig {
            fields: vec![(FIELD.to_string(), vec!["title".to_string()])],
            adapter: Some(AdapterSetting::Named("shared".into())),
        }),
        ..config(BRUTE_FORCE_THRESHOLD)
    };
    assert_eq!(
        code_of(engine.create_index(INDEX, embedding_config())),
        ErrorCode::EMBEDDING_CONFIG_INVALID
    );
    engine
        .register_embedding_adapter("shared", named(0, DIMENSION))
        .expect("registered");
    engine
        .create_index(INDEX, embedding_config())
        .expect("the index is created");
    engine
        .insert(INDEX, document("one", "abc", None), None)
        .expect("embedded");
    assert_eq!(stored_vector(&engine, "one"), Some(vector_of(3)));

    let mismatch = engine
        .register_embedding_adapter("shared", named(100, DIMENSION + 1))
        .expect_err("a wrong length is refused");
    assert_eq!(mismatch.code(), ErrorCode::EMBEDDING_DIMENSION_MISMATCH);
    engine
        .insert(INDEX, document("two", "abcd", None), None)
        .expect("the old adapter stays");
    assert_eq!(stored_vector(&engine, "two"), Some(vector_of(4)));

    engine
        .register_embedding_adapter("shared", named(100, DIMENSION))
        .expect("registered again");
    engine
        .insert(INDEX, document("three", "abcde", None), None)
        .expect("embedded by the new adapter");
    assert_eq!(stored_vector(&engine, "three"), Some(vector_of(105)));
    assert_eq!(
        code_of(engine.register_embedding_adapter("  ", named(0, DIMENSION))),
        ErrorCode::EMBEDDING_CONFIG_INVALID
    );
}

const CAPPED_INDEX_VECTORS: u64 = 40_000;
const OVERSAMPLED_DEPTH_CAP: usize = 10_000;
const CAPPED_LIMIT: usize = 9;
const HUGE_OVERSAMPLE: f64 = 1e9;
const TIMED_SEARCHES: usize = 9;
const SAME_TIME_RATIO: f64 = 1.5;
const SAME_TIME_SLACK: Duration = Duration::from_millis(5);

fn oversampled_hits(
    engine: &Narsil,
    target: &[f32],
    oversample: f64,
) -> (Vec<(String, Option<u64>)>, Duration) {
    let mut params = vector_query(target, CAPPED_LIMIT);
    if let Some(clause) = params.vector.as_mut() {
        clause.oversample = Some(oversample);
    }
    let started = Instant::now();
    let hits = engine
        .query(INDEX, &params)
        .expect("the search succeeds")
        .hits;
    let elapsed = started.elapsed();
    let ranked = hits
        .into_iter()
        .map(|hit| (hit.id, hit.score.map(f64::to_bits)))
        .collect();
    (ranked, elapsed)
}

fn median(mut times: Vec<Duration>) -> Duration {
    times.sort();
    times[times.len() / 2]
}

#[test]
fn a_huge_oversample_on_a_one_bit_graph_returns_the_depth_cap_hits_in_about_the_same_time() {
    let engine = Narsil::new();
    let mut settings = config(GRAPH_THRESHOLD);
    if let Some(promotion) = settings.vector_promotion.as_mut() {
        promotion.quantization = Some(Quantization::Osq1);
    }
    engine
        .create_index(INDEX, settings)
        .expect("the index is created");
    let documents: Vec<Map> = (0..CAPPED_INDEX_VECTORS)
        .map(|n| document(&format!("doc-{n}"), "note", Some(as_value(&vector_of(n)))))
        .collect();
    assert!(
        engine
            .insert_batch(INDEX, documents)
            .expect("inserted")
            .failed
            .is_empty()
    );
    engine.optimize_vectors(INDEX, None).expect("optimised");
    let status = engine.vector_maintenance_status(INDEX).expect("a status");
    assert_eq!(status[0].graph_count, 1);

    let target = vector_of(90_001);
    let at_cap = (OVERSAMPLED_DEPTH_CAP / (CAPPED_LIMIT + 1)) as f64;
    let (capped, _) = oversampled_hits(&engine, &target, at_cap);
    let (huge, _) = oversampled_hits(&engine, &target, HUGE_OVERSAMPLE);
    assert_eq!(huge, capped);

    let mut oracle: Vec<(f64, String)> = (0..CAPPED_INDEX_VECTORS)
        .map(|n| (cosine(&target, &vector_of(n)), format!("doc-{n}")))
        .collect();
    oracle.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let wanted: Vec<&str> = oracle
        .iter()
        .take(CAPPED_LIMIT)
        .map(|(_, id)| id.as_str())
        .collect();
    let returned: Vec<&str> = huge.iter().map(|(id, _)| id.as_str()).collect();
    assert_eq!(returned, wanted);

    let mut capped_times = Vec::with_capacity(TIMED_SEARCHES);
    let mut huge_times = Vec::with_capacity(TIMED_SEARCHES);
    for _ in 0..TIMED_SEARCHES {
        capped_times.push(oversampled_hits(&engine, &target, at_cap).1);
        huge_times.push(oversampled_hits(&engine, &target, HUGE_OVERSAMPLE).1);
    }
    let capped_median = median(capped_times);
    let huge_median = median(huge_times);
    assert!(
        huge_median < capped_median.mul_f64(SAME_TIME_RATIO) + SAME_TIME_SLACK,
        "a huge oversample took {huge_median:?}, against {capped_median:?} at the depth cap"
    );
}
