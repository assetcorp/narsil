mod support;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use narsil::{
    DurabilityConfig, IndexConfig, Map, Narsil, NarsilConfig, QueryParams, Storage, Value,
    VectorPromotion, VectorQuery, parse_json,
};
use support::ScratchDirectory;

const INDEX: &str = "articles";
const FIELD: &str = "embedding";
const DIMENSION: usize = 32;
const GRAPH_THRESHOLD: u64 = 256;
const DOCUMENTS: u64 = 1_200;
const BUCKETS: u64 = 100;
const NARROW_FILTER_BUCKETS: u64 = 2;
const WIDE_FILTER_BUCKETS: u64 = 50;
const SIMILARITY_FLOOR: f64 = 0.2;
const WRITES_OF_EACH_KIND: u64 = 12;
const UPDATED_SEED_OFFSET: u64 = 1_000_000;
const QUERY_SEED_OFFSET: u64 = 2_000_000;
const QUERIES: u64 = 12;
const LIMIT: usize = 15;
const EVERY_CANDIDATE: u32 = 10_000;
const RESCORE_EVERY_CANDIDATE: f64 = 1_000.0;
const SCORE_TOLERANCE: f64 = 1e-4;
const FLOAT32_BYTES: u64 = 4;

struct Held {
    vector: Vec<f32>,
    bucket: u64,
}

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

fn document(id: &str, held: &Held) -> Map {
    let mut map = Map::new();
    map.insert("id", Value::String(id.to_string()));
    map.insert("title", Value::String(format!("article {id}")));
    map.insert("bucket", Value::Number(held.bucket as f64));
    map.insert(
        FIELD,
        Value::Array(
            held.vector
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
            r#"{{"title": "string", "bucket": "number", "{FIELD}": "vector[{DIMENSION}]"}}"#
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

fn store(engine: &Narsil, live: &mut BTreeMap<String, Held>, seed: u64, vector_seed: u64) {
    let id = format!("doc-{seed}");
    let held = Held {
        vector: vector_of(vector_seed),
        bucket: seed % BUCKETS,
    };
    let stored = if live.contains_key(&id) {
        engine.update(INDEX, &id, document(&id, &held))
    } else {
        engine
            .insert_batch(INDEX, vec![document(&id, &held)])
            .map(|result| assert!(result.failed.is_empty(), "{id} is stored"))
    };
    stored.expect("the document is stored");
    live.insert(id, held);
}

fn written_checkpoint(root: &Path) -> BTreeMap<String, Held> {
    let mut live = BTreeMap::new();
    let engine = Narsil::open(durable(root)).expect("the engine opens");
    engine
        .create_index(INDEX, disk_vectors())
        .expect("the index is created");
    let mut documents = Vec::new();
    for seed in 0..DOCUMENTS {
        let id = format!("doc-{seed}");
        let held = Held {
            vector: vector_of(seed),
            bucket: seed % BUCKETS,
        };
        documents.push(document(&id, &held));
        live.insert(id, held);
    }
    let stored = engine
        .insert_batch(INDEX, documents)
        .expect("the batch is stored");
    assert!(stored.failed.is_empty(), "every document is stored");
    engine
        .optimize_vectors(INDEX, Some(FIELD))
        .expect("the graph is built");
    engine.checkpoint(INDEX).expect("the checkpoint is written");
    engine.shutdown().expect("the engine shuts down");
    live
}

struct Shape {
    label: &'static str,
    buckets_below: Option<u64>,
    floor: Option<f64>,
}

const SHAPES: [Shape; 4] = [
    Shape {
        label: "every document",
        buckets_below: None,
        floor: None,
    },
    Shape {
        label: "a filter that few documents pass",
        buckets_below: Some(NARROW_FILTER_BUCKETS),
        floor: None,
    },
    Shape {
        label: "a filter that half the documents pass",
        buckets_below: Some(WIDE_FILTER_BUCKETS),
        floor: None,
    },
    Shape {
        label: "a similarity floor",
        buckets_below: None,
        floor: Some(SIMILARITY_FLOOR),
    },
];

fn exhaustive_query(target: &[f32], shape: &Shape) -> QueryParams {
    QueryParams {
        vector: Some(VectorQuery {
            field: FIELD.to_string(),
            value: Some(target.to_vec()),
            similarity: shape.floor,
            ef_search: Some(EVERY_CANDIDATE),
            oversample: Some(RESCORE_EVERY_CANDIDATE),
            ..VectorQuery::default()
        }),
        filters: shape.buckets_below.map(|below| {
            parse_json(&format!(r#"{{"fields": {{"bucket": {{"lt": {below}}}}}}}"#))
                .expect("the filter is JSON")
        }),
        limit: Some(LIMIT),
        ..QueryParams::default()
    }
}

fn exact_scan(live: &BTreeMap<String, Held>, target: &[f32], shape: &Shape) -> Vec<(String, f64)> {
    let mut scored: Vec<(String, f64)> = live
        .iter()
        .filter(|(_, held)| shape.buckets_below.is_none_or(|below| held.bucket < below))
        .map(|(id, held)| (id.clone(), cosine(target, &held.vector)))
        .filter(|(_, score)| shape.floor.is_none_or(|floor| *score >= floor))
        .collect();
    scored.sort_by(|left, right| {
        right
            .1
            .total_cmp(&left.1)
            .then_with(|| left.0.cmp(&right.0))
    });
    scored
}

fn require_answers_match_an_exact_scan(
    engine: &Narsil,
    live: &BTreeMap<String, Held>,
    stage: &str,
) {
    for query in 0..QUERIES {
        let target = vector_of(QUERY_SEED_OFFSET + query);
        for shape in &SHAPES {
            let label = shape.label;
            let scanned = exact_scan(live, &target, shape);
            let wanted = scanned.len().min(LIMIT);
            let hits = engine
                .query(INDEX, &exhaustive_query(&target, shape))
                .unwrap_or_else(|error| panic!("{stage}, {label}: the search fails with {error:?}"))
                .hits;
            assert_eq!(hits.len(), wanted, "{stage}, {label}: the number of hits");
            let lowest_wanted = scanned.get(wanted.saturating_sub(1)).map(|entry| entry.1);
            let mut seen = std::collections::BTreeSet::new();
            for hit in hits {
                let exact = scanned
                    .iter()
                    .find(|entry| entry.0 == hit.id)
                    .map(|entry| entry.1)
                    .unwrap_or_else(|| {
                        panic!(
                            "{stage}, {label}: {} fails the search or is removed",
                            hit.id
                        )
                    });
                let score = hit.score.expect("a vector hit carries a score");
                assert!(
                    (score - exact).abs() < SCORE_TOLERANCE,
                    "{stage}, {label}: {} scores {score}, the exact scan {exact}",
                    hit.id
                );
                assert!(
                    lowest_wanted.is_some_and(|lowest| exact > lowest - SCORE_TOLERANCE),
                    "{stage}, {label}: {} at {exact} ranks below the first {wanted} of the exact scan",
                    hit.id
                );
                assert!(
                    seen.insert(hit.id.clone()),
                    "{stage}, {label}: {} twice",
                    hit.id
                );
            }
        }
    }
}

fn stored_vector(engine: &Narsil, id: &str) -> Option<Vec<f32>> {
    let document = engine.get(INDEX, id).expect("the document read succeeds")?;
    match document.get(FIELD) {
        Some(Value::Array(values)) => Some(
            values
                .iter()
                .map(|value| value.as_f64().expect("a vector holds numbers") as f32)
                .collect(),
        ),
        _ => None,
    }
}

fn reads_from_files(engine: &Narsil) -> bool {
    engine
        .vector_maintenance_status(INDEX)
        .expect("the index reports its vector fields")
        .iter()
        .any(|status| status.field_name == FIELD && status.loading_from_files)
}

fn remove_replace_and_add(engine: &Narsil, live: &mut BTreeMap<String, Held>) {
    for seed in 0..WRITES_OF_EACH_KIND {
        let id = format!("doc-{seed}");
        engine.remove(INDEX, &id).expect("the document is removed");
        live.remove(&id);
    }
    for seed in WRITES_OF_EACH_KIND..WRITES_OF_EACH_KIND * 2 {
        store(engine, live, seed, UPDATED_SEED_OFFSET + seed);
    }
    for seed in DOCUMENTS..DOCUMENTS + WRITES_OF_EACH_KIND {
        store(engine, live, seed, seed);
    }
}

fn require_stored_vectors(engine: &Narsil, live: &BTreeMap<String, Held>, stage: &str) {
    assert_eq!(
        stored_vector(engine, "doc-0"),
        None,
        "{stage}: a removed document"
    );
    for id in [
        format!("doc-{WRITES_OF_EACH_KIND}"),
        format!("doc-{DOCUMENTS}"),
        format!("doc-{}", DOCUMENTS - 1),
    ] {
        assert_eq!(
            stored_vector(engine, &id).as_ref(),
            live.get(&id).map(|held| &held.vector),
            "{stage}: the vector of {id}"
        );
    }
}

fn graph_part_file(root: &Path) -> PathBuf {
    let segments = root.join(INDEX).join("segments");
    std::fs::read_dir(&segments)
        .expect("the segment directory reads")
        .map(|entry| entry.expect("the entry reads").path())
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("vec-") && name.contains("-graph-"))
        })
        .expect("the checkpoint wrote a graph part")
}

#[test]
fn a_field_that_cannot_load_answers_from_its_files_as_an_exact_scan_does_through_writes() {
    let scratch = ScratchDirectory::new("cold-vectors-on-files");
    let mut live = written_checkpoint(scratch.path());
    let path = graph_part_file(scratch.path());
    let mut bytes = std::fs::read(&path).expect("the graph part reads");
    let name_at = bytes
        .windows(FIELD.len())
        .position(|window| window == FIELD.as_bytes())
        .expect("the graph part holds the name of its field");
    bytes[name_at] ^= 0x01;
    std::fs::write(&path, &bytes).expect("the damaged graph part is written");

    let engine = Narsil::open(durable(scratch.path())).expect("the engine reopens");
    require_answers_match_an_exact_scan(&engine, &live, "from the files");
    assert_eq!(
        refusal_of(engine.optimize_vectors(INDEX, Some(FIELD))),
        Some("PERSISTENCE_CRC_MISMATCH"),
        "the load of the damaged graph part"
    );
    remove_replace_and_add(&engine, &mut live);
    assert!(
        reads_from_files(&engine),
        "the field that failed its load answers from its files"
    );
    require_stored_vectors(&engine, &live, "from the files");
    require_answers_match_an_exact_scan(&engine, &live, "from the files after writes");

    engine
        .clear(INDEX)
        .expect("the index clears while its field answers from its files");
    live.clear();
    require_answers_match_an_exact_scan(&engine, &live, "after the clear");
    store(&engine, &mut live, 0, 0);
    require_answers_match_an_exact_scan(&engine, &live, "after a write to the cleared index");
    engine.shutdown().expect("the engine shuts down");

    let engine = Narsil::open(durable(scratch.path())).expect("the engine reopens again");
    require_answers_match_an_exact_scan(&engine, &live, "after the clear and a restart");
    engine.shutdown().expect("the engine shuts down");
}

#[test]
fn a_restored_disk_field_keeps_every_write_through_its_load_and_a_restart() {
    let scratch = ScratchDirectory::new("cold-vectors");
    let mut live = written_checkpoint(scratch.path());
    {
        let engine = Narsil::open(durable(scratch.path())).expect("the engine reopens");
        remove_replace_and_add(&engine, &mut live);
        require_stored_vectors(&engine, &live, "before the load");
        require_answers_match_an_exact_scan(&engine, &live, "before the load");
        engine
            .optimize_vectors(INDEX, Some(FIELD))
            .expect("the field loads and takes the held writes");
        assert!(!reads_from_files(&engine), "the field finished its load");
        require_answers_match_an_exact_scan(&engine, &live, "after the load");
        engine.checkpoint(INDEX).expect("the checkpoint is written");
        engine.shutdown().expect("the engine shuts down");
    }
    let engine = Narsil::open(durable(scratch.path())).expect("the engine reopens again");
    require_answers_match_an_exact_scan(&engine, &live, "after a second restart");
    let held = engine
        .get_stats(INDEX)
        .expect("the index reports its figures")
        .document_count;
    assert_eq!(held, live.len() as u64, "every live document survives");
    engine.shutdown().expect("the engine shuts down");
}

fn largest_vector_file(root: &Path) -> PathBuf {
    let segments = root.join(INDEX).join("segments");
    std::fs::read_dir(&segments)
        .expect("the segment directory reads")
        .map(|entry| entry.expect("the entry reads").path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("vec-") && !name.contains("-graph-"))
        })
        .max_by_key(|path| std::fs::metadata(path).map_or(0, |found| found.len()))
        .expect("the checkpoint wrote a vector file")
}

fn refusal_of<T>(outcome: narsil::Result<T>) -> Option<&'static str> {
    outcome.err().map(|error| error.code().as_str())
}

#[test]
fn a_damaged_vector_page_fails_the_search_and_the_load_with_a_checksum_error() {
    let scratch = ScratchDirectory::new("cold-vectors-damaged");
    written_checkpoint(scratch.path());
    let path = largest_vector_file(scratch.path());
    let mut bytes = std::fs::read(&path).expect("the vector file reads");
    let vector_bytes = DOCUMENTS * DIMENSION as u64 * FLOAT32_BYTES;
    assert!(
        vector_bytes * 2 > bytes.len() as u64,
        "the vectors cover the middle of the file: {vector_bytes} of {} bytes",
        bytes.len()
    );
    let middle = bytes.len() / 2;
    bytes[middle] ^= 0x01;
    std::fs::write(&path, &bytes).expect("the damaged file is written");

    let engine = Narsil::open(durable(scratch.path())).expect("the engine reopens");
    let target = vector_of(QUERY_SEED_OFFSET);
    assert_eq!(
        refusal_of(engine.query(INDEX, &exhaustive_query(&target, &SHAPES[0]))),
        Some("PERSISTENCE_CRC_MISMATCH"),
        "a search that reads the damaged page"
    );
    assert_eq!(
        refusal_of(engine.optimize_vectors(INDEX, Some(FIELD))),
        Some("PERSISTENCE_CRC_MISMATCH"),
        "the load of the damaged file"
    );
    assert_eq!(
        refusal_of(engine.checkpoint(INDEX)),
        Some("PERSISTENCE_CRC_MISMATCH"),
        "a checkpoint of the field that failed its load"
    );
    engine.shutdown().expect("the engine shuts down");
}

#[test]
fn a_truncated_vector_file_refuses_the_open() {
    let scratch = ScratchDirectory::new("cold-vectors-truncated");
    written_checkpoint(scratch.path());
    let path = largest_vector_file(scratch.path());
    let bytes = std::fs::read(&path).expect("the vector file reads");
    std::fs::write(&path, &bytes[..bytes.len() - 1]).expect("the truncated file is written");

    let opened = Narsil::open(durable(scratch.path())).and_then(|engine| {
        let found = engine.query(INDEX, &exhaustive_query(&vector_of(0), &SHAPES[0]));
        engine.shutdown()?;
        found
    });
    assert_eq!(refusal_of(opened), Some("PERSISTENCE_LOAD_FAILED"));
}

#[cfg(target_os = "linux")]
const SHUTDOWNS_DURING_A_LOAD: usize = 12;

#[cfg(target_os = "linux")]
fn handles_under(root: &Path) -> Vec<String> {
    let root = root.to_string_lossy().into_owned();
    let mut held: Vec<String> = std::fs::read_dir("/proc/self/fd")
        .expect("the process lists its descriptors")
        .filter_map(|entry| std::fs::read_link(entry.ok()?.path()).ok())
        .map(|target| target.to_string_lossy().into_owned())
        .filter(|target| target.starts_with(&root))
        .collect();
    let mappings =
        std::fs::read_to_string("/proc/self/maps").expect("the process lists its mappings");
    held.extend(
        mappings
            .lines()
            .filter_map(|line| line.find(&root).map(|at| line[at..].to_string())),
    );
    held
}

#[cfg(target_os = "linux")]
#[test]
fn a_shutdown_during_the_load_of_a_disk_field_closes_every_file_of_the_index() {
    let scratch = ScratchDirectory::new("cold-vectors-shutdown");
    written_checkpoint(scratch.path());
    for cycle in 0..SHUTDOWNS_DURING_A_LOAD {
        let engine = Narsil::open(durable(scratch.path())).expect("the engine reopens");
        engine
            .query(
                INDEX,
                &exhaustive_query(&vector_of(QUERY_SEED_OFFSET), &SHAPES[0]),
            )
            .expect("the search answers from the files and starts the load");
        engine.shutdown().expect("the engine shuts down");
        let held = handles_under(scratch.path());
        assert!(
            held.is_empty(),
            "shutdown {cycle} returned while the process held these files of the index: {held:?}"
        );
    }
}
