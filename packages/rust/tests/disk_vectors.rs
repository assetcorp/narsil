mod support;

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use narsil::{
    DurabilityConfig, IndexConfig, Map, Narsil, NarsilConfig, QueryParams, Storage, Value,
    VectorPromotion, VectorQuery, parse_json,
};
use support::ScratchDirectory;

const INDEX: &str = "articles";
const FIELD: &str = "embedding";
const DIMENSION: usize = 64;
const GRAPH_THRESHOLD: u64 = 256;
const FIRST_BATCH: u64 = 4_096;
const SECOND_BATCH: u64 = 2_048;
const REMOVED_FROM_FIRST_BATCH: u64 = 1_000;
const UPDATED_FROM_FIRST_BATCH: u64 = 500;
const UPDATED_SEED_OFFSET: u64 = 1_000_000;
const QUERY_SEED_OFFSET: u64 = 2_000_000;
const QUERIES: u64 = 40;
const LIMIT: usize = 20;
const SCORE_TOLERANCE: f64 = 1e-4;
const FLOAT32_BYTES: u64 = 4;

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

fn document(id: &str, vector: &[f32]) -> Map {
    let mut map = Map::new();
    map.insert("id", Value::String(id.to_string()));
    map.insert("title", Value::String(format!("article {id}")));
    map.insert(
        FIELD,
        Value::Array(
            vector
                .iter()
                .map(|element| Value::Number(f64::from(*element)))
                .collect(),
        ),
    );
    map
}

fn durable(root: &Path) -> NarsilConfig {
    NarsilConfig {
        durability: Some(DurabilityConfig {
            directory: Some(root.to_path_buf()),
            ..DurabilityConfig::default()
        }),
        ..NarsilConfig::default()
    }
}

fn disk_vectors() -> IndexConfig {
    IndexConfig {
        schema: parse_json(&format!(
            r#"{{"title": "string", "{FIELD}": "vector[{DIMENSION}]"}}"#
        ))
        .expect("the schema is JSON"),
        vector_promotion: Some(VectorPromotion {
            threshold: Some(GRAPH_THRESHOLD),
            storage: Some(Storage::Disk),
            ..VectorPromotion::default()
        }),
        ..IndexConfig::default()
    }
}

fn insert_range(
    engine: &Narsil,
    live: &mut BTreeMap<String, Vec<f32>>,
    seeds: std::ops::Range<u64>,
) {
    let mut documents = Vec::new();
    for seed in seeds {
        let id = format!("doc-{seed}");
        let vector = vector_of(seed);
        documents.push(document(&id, &vector));
        live.insert(id, vector);
    }
    let result = engine
        .insert_batch(INDEX, documents)
        .expect("the batch is stored");
    assert!(result.failed.is_empty(), "every document is stored");
}

fn vector_memory_bytes(engine: &Narsil) -> u64 {
    let index_bytes = engine
        .get_stats(INDEX)
        .expect("the index reports its figures")
        .estimated_memory_bytes;
    let text_bytes: u64 = engine
        .get_partition_stats(INDEX)
        .expect("the partitions report their figures")
        .iter()
        .map(|partition| partition.estimated_memory_bytes)
        .sum();
    index_bytes.saturating_sub(text_bytes)
}

fn vector_query(vector: &[f32]) -> QueryParams {
    QueryParams {
        vector: Some(VectorQuery {
            field: FIELD.to_string(),
            value: Some(vector.to_vec()),
            ..VectorQuery::default()
        }),
        limit: Some(LIMIT),
        ..QueryParams::default()
    }
}

fn require_scores_match_the_oracle(
    engine: &Narsil,
    live: &BTreeMap<String, Vec<f32>>,
    stage: &str,
) {
    for query in 0..QUERIES {
        let target = vector_of(QUERY_SEED_OFFSET + query);
        let hits = engine
            .query(INDEX, &vector_query(&target))
            .expect("the vector search succeeds")
            .hits;
        assert_eq!(hits.len(), LIMIT, "{stage}: a full page of hits");
        for hit in hits {
            let held = live
                .get(&hit.id)
                .unwrap_or_else(|| panic!("{stage}: {} is a removed or unknown document", hit.id));
            let wanted = cosine(&target, held);
            let score = hit.score.expect("a vector hit carries a score");
            assert!(
                (score - wanted).abs() < SCORE_TOLERANCE,
                "{stage}: {} scores {score}, the oracle {wanted}",
                hit.id
            );
        }
    }
}

fn checkpoint_beside_searches(engine: &Narsil, live: &BTreeMap<String, Vec<f32>>, stage: &str) {
    let finished = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let reader = scope.spawn(|| {
            while !finished.load(Ordering::Acquire) {
                require_scores_match_the_oracle(engine, live, stage);
            }
        });
        engine.checkpoint(INDEX).expect("the checkpoint is written");
        finished.store(true, Ordering::Release);
        reader
            .join()
            .expect("the searches beside the checkpoint succeed");
    });
}

#[test]
fn disk_vectors_leave_memory_once_a_checkpoint_writes_them_and_still_score_exactly() {
    let scratch = ScratchDirectory::new("disk-vectors");
    let first_batch_bytes = FIRST_BATCH * DIMENSION as u64 * FLOAT32_BYTES;
    let mut live = BTreeMap::new();
    let after_second;
    {
        let engine = Narsil::open(durable(scratch.path())).expect("the engine opens");
        engine
            .create_index(INDEX, disk_vectors())
            .expect("the index is created");
        insert_range(&engine, &mut live, 0..FIRST_BATCH);
        engine
            .optimize_vectors(INDEX, Some(FIELD))
            .expect("the graph is built");
        let before_first = vector_memory_bytes(&engine);
        checkpoint_beside_searches(&engine, &live, "during the first checkpoint");
        let after_first = vector_memory_bytes(&engine);
        assert!(
            before_first.saturating_sub(after_first) >= first_batch_bytes * 3 / 4,
            "the checkpoint frees the vectors that it wrote: {before_first} bytes before, {after_first} after"
        );
        require_scores_match_the_oracle(&engine, &live, "after the first checkpoint");

        for seed in 0..REMOVED_FROM_FIRST_BATCH {
            let id = format!("doc-{seed}");
            engine.remove(INDEX, &id).expect("the document is removed");
            live.remove(&id);
        }
        for seed in REMOVED_FROM_FIRST_BATCH..REMOVED_FROM_FIRST_BATCH + UPDATED_FROM_FIRST_BATCH {
            let id = format!("doc-{seed}");
            let vector = vector_of(UPDATED_SEED_OFFSET + seed);
            engine
                .update(INDEX, &id, document(&id, &vector))
                .expect("the document is replaced");
            live.insert(id, vector);
        }
        insert_range(&engine, &mut live, FIRST_BATCH..FIRST_BATCH + SECOND_BATCH);
        engine
            .compact_vectors(INDEX, Some(FIELD))
            .expect("the removed vectors are compacted");
        engine
            .optimize_vectors(INDEX, Some(FIELD))
            .expect("the graph takes the new vectors");
        require_scores_match_the_oracle(&engine, &live, "after the writes");
        let before_second = vector_memory_bytes(&engine);
        checkpoint_beside_searches(&engine, &live, "during the second checkpoint");
        after_second = vector_memory_bytes(&engine);
        assert!(
            after_second < before_second,
            "the second checkpoint frees the vectors that it wrote: {before_second} bytes before, {after_second} after"
        );
        require_scores_match_the_oracle(&engine, &live, "after the second checkpoint");
        engine.shutdown().expect("the engine shuts down");
    }
    let engine = Narsil::open(durable(scratch.path())).expect("the engine reopens");
    require_scores_match_the_oracle(&engine, &live, "after a restart");
    let reopened = vector_memory_bytes(&engine);
    assert!(
        reopened <= after_second + first_batch_bytes / 4,
        "the reopened index reads its vectors from disk: {reopened} bytes, {after_second} before the restart"
    );
    let held = engine
        .get_stats(INDEX)
        .expect("the index reports its figures")
        .document_count;
    assert_eq!(held, live.len() as u64, "every live document survives");
    engine.shutdown().expect("the engine shuts down");
}
