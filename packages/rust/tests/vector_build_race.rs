mod support;

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use narsil::{
    DurabilityConfig, DurabilityMode, IndexConfig, Map, Narsil, NarsilConfig, QueryParams, Value,
    VectorPromotion, VectorQuery, parse_json,
};
use support::{ScratchDirectory, repository_root};

const INDEX: &str = "bills";
const FIELD: &str = "embedding";
const DIMENSION: usize = 48;
const GRAPH_THRESHOLD: u64 = 256;
const WAVES: u64 = 12;
const WAVE_DOCUMENTS: u64 = 600;
const UPDATE_SEED: u64 = 1_000_000;
const QUERY_SEED: u64 = 50_000_000;
const ORACLE_QUERIES: u64 = 60;
const LIMIT: usize = 10;
const READERS: u64 = 3;
const SCORE_TOLERANCE: f64 = 1e-4;
const RECALL_FLOOR: f64 = 0.9;
const BUILD_SETTLE_TIMEOUT: Duration = Duration::from_secs(60);
const BUILD_SETTLE_POLL: Duration = Duration::from_millis(10);
const CHILD_DIRECTORY: &str = "NARSIL_VECTOR_BUILD_KILL_DIRECTORY";
const CHILD_FIRST_ID: &str = "NARSIL_VECTOR_BUILD_KILL_FIRST_ID";
const CHILD_ROUND: &str = "NARSIL_VECTOR_BUILD_KILL_ROUND";
const KILL_ROUNDS: u64 = 2;
const CHILD_LINE_MARK: &str = "narsil-child: ";
const CHILD_GO: &str = "go";
const ROUND_ID_STRIDE: u64 = 1_000_000;
const ACKS_WHILE_BUILDING_BEFORE_KILL: u64 = 40;

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

fn id_of(number: u64) -> String {
    format!("doc-{number}")
}

fn document(number: u64, seed: u64) -> Map {
    let mut map = Map::new();
    map.insert("id", Value::String(id_of(number)));
    map.insert("title", Value::String(format!("bill {number}")));
    map.insert(FIELD, as_value(&vector_of(seed)));
    map
}

fn cosine(left: &[f32], right: &[f32]) -> f64 {
    let mut dot = 0.0;
    let mut left_norm = 0.0;
    let mut right_norm = 0.0;
    for (a, b) in left.iter().zip(right) {
        dot += f64::from(*a) * f64::from(*b);
        left_norm += f64::from(*a) * f64::from(*a);
        right_norm += f64::from(*b) * f64::from(*b);
    }
    dot / (left_norm.sqrt() * right_norm.sqrt())
}

fn index_config() -> IndexConfig {
    IndexConfig {
        schema: parse_json(&format!(
            r#"{{"title": "string", "{FIELD}": "vector[{DIMENSION}]"}}"#
        ))
        .expect("the schema is JSON"),
        vector_promotion: Some(VectorPromotion {
            threshold: Some(GRAPH_THRESHOLD),
            ..VectorPromotion::default()
        }),
        ..IndexConfig::default()
    }
}

fn durable_config(root: &Path, mode: DurabilityMode) -> NarsilConfig {
    NarsilConfig {
        durability: Some(DurabilityConfig {
            directory: Some(root.to_path_buf()),
            mode: Some(mode),
            ..DurabilityConfig::default()
        }),
        ..NarsilConfig::default()
    }
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

fn vector_in(document: &Map) -> Vec<f32> {
    let Some(Value::Array(items)) = document.get(FIELD) else {
        panic!("the document lacks its vector");
    };
    items
        .iter()
        .map(|item| item.as_f64().expect("a number") as f32)
        .collect()
}

fn building(engine: &Narsil) -> bool {
    engine
        .vector_maintenance_status(INDEX)
        .expect("a status")
        .iter()
        .any(|status| status.building)
}

fn settle_build(engine: &Narsil) {
    engine
        .optimize_vectors(INDEX, None)
        .expect("the field optimises");
    let started = Instant::now();
    loop {
        let statuses = engine.vector_maintenance_status(INDEX).expect("a status");
        if statuses
            .iter()
            .all(|status| !status.building && status.buffer_size == 0)
        {
            return;
        }
        assert!(
            started.elapsed() < BUILD_SETTLE_TIMEOUT,
            "the build never settles: {statuses:?}"
        );
        engine
            .optimize_vectors(INDEX, None)
            .expect("the field optimises");
        std::thread::sleep(BUILD_SETTLE_POLL);
    }
}

fn require_consistent_hits(target: &[f32], params_result: &narsil::QueryResult) {
    for hit in &params_result.hits {
        let stored = vector_in(&hit.document);
        let wanted = cosine(target, &stored);
        let score = hit.score.expect("a score");
        assert!(
            (score - wanted).abs() < SCORE_TOLERANCE,
            "{} scores {score} while its returned vector scores {wanted}",
            hit.id
        );
    }
}

fn require_searches_match_oracle(engine: &Narsil, live: &HashMap<String, Vec<f32>>, when: &str) {
    let mut found = 0usize;
    for query in 0..ORACLE_QUERIES {
        let target = vector_of(QUERY_SEED + query);
        let result = engine
            .query(INDEX, &vector_query(&target))
            .expect("the search succeeds");
        let mut oracle: Vec<(f64, &str)> = live
            .iter()
            .map(|(id, vector)| (cosine(&target, vector), id.as_str()))
            .collect();
        oracle.sort_by(|a, b| b.0.total_cmp(&a.0));
        let wanted: HashSet<&str> = oracle.iter().take(LIMIT).map(|(_, id)| *id).collect();
        assert_eq!(result.hits.len(), LIMIT.min(live.len()), "{when}");
        for hit in &result.hits {
            let Some(current) = live.get(&hit.id) else {
                panic!(
                    "{when}: the search returns {}, which the oracle holds removed",
                    hit.id
                );
            };
            let score = hit.score.expect("a score");
            let truth = cosine(&target, current);
            assert!(
                (score - truth).abs() < SCORE_TOLERANCE,
                "{when}: {} scores {score}, but its current vector scores {truth}",
                hit.id
            );
            assert_eq!(&vector_in(&hit.document), current, "{when}: {}", hit.id);
            if wanted.contains(hit.id.as_str()) {
                found += 1;
            }
        }
    }
    let recall = found as f64 / (ORACLE_QUERIES as f64 * LIMIT as f64);
    assert!(recall >= RECALL_FLOOR, "{when}: the recall is {recall}");
}

struct GraphCounts {
    node_count: u64,
    tombstone_count: u64,
    live_nodes: Vec<String>,
    live_without_node: Vec<String>,
}

fn saved_graph_counts(root: &Path) -> GraphCounts {
    let script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/reference_graph_counts.mjs");
    let output = Command::new("node")
        .arg(script)
        .arg(repository_root())
        .arg(root)
        .arg(INDEX)
        .output()
        .expect("node reads the checkpoint");
    assert!(
        output.status.success(),
        "the checkpoint reader failed; install packages/ts first: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let parsed =
        parse_json(&String::from_utf8_lossy(&output.stdout)).expect("the reader writes JSON");
    let fields = parsed.as_array().expect("one entry per field");
    assert_eq!(fields.len(), 1);
    let field = &fields[0];
    let number = |key: &str| field.pointer(key).and_then(Value::as_f64).expect("a count") as u64;
    let ids = |key: &str| -> Vec<String> {
        field
            .pointer(key)
            .and_then(Value::as_array)
            .expect("a list")
            .iter()
            .map(|id| id.as_str().expect("an ID").to_string())
            .collect()
    };
    assert!(number("graphParts") > 0, "the checkpoint holds no graph");
    GraphCounts {
        node_count: number("nodeCount"),
        tombstone_count: number("tombstoneCount"),
        live_nodes: ids("liveNodes"),
        live_without_node: ids("liveWithoutNode"),
    }
}

fn require_graph_holds_live_documents(
    engine: &Narsil,
    root: &Path,
    live: &HashMap<String, Vec<f32>>,
    when: &str,
) {
    engine.checkpoint(INDEX).expect("the checkpoint commits");
    let counts = saved_graph_counts(root);
    assert!(
        counts.live_without_node.is_empty(),
        "{when}: {} live vectors have no node, such as {:?}",
        counts.live_without_node.len(),
        counts.live_without_node.first()
    );
    let nodes: HashSet<&String> = counts.live_nodes.iter().collect();
    assert_eq!(
        nodes.len(),
        counts.live_nodes.len(),
        "{when}: a document holds two live nodes"
    );
    let wanted: HashSet<&String> = live.keys().collect();
    assert_eq!(
        nodes, wanted,
        "{when}: the live nodes differ from the live documents"
    );
    assert_eq!(
        counts.node_count,
        live.len() as u64 + counts.tombstone_count,
        "{when}: nodeCount"
    );
    let ratio = engine.vector_maintenance_status(INDEX).expect("a status")[0].tombstone_ratio;
    let saved_ratio = counts.tombstone_count as f64 / counts.node_count as f64;
    assert!(
        (ratio - saved_ratio).abs() < 1e-9,
        "{when}: the field reports a tombstone ratio of {ratio}, the checkpoint {saved_ratio}"
    );
    engine
        .compact_vectors(INDEX, None)
        .expect("the field compacts");
    engine.checkpoint(INDEX).expect("the checkpoint commits");
    let compacted = saved_graph_counts(root);
    assert_eq!(
        compacted.tombstone_count, 0,
        "{when}: tombstoneCount after compaction"
    );
    assert_eq!(
        compacted.node_count,
        live.len() as u64,
        "{when}: nodeCount after compaction"
    );
}

#[test]
fn removals_and_updates_during_a_background_build_leave_only_current_vectors() {
    let root = ScratchDirectory::new("vector-build-race");
    let engine =
        Narsil::open(durable_config(root.path(), DurabilityMode::Async)).expect("the engine opens");
    engine
        .create_index(INDEX, index_config())
        .expect("the index is created");
    let mut live: HashMap<String, Vec<f32>> = HashMap::new();
    let writing = AtomicBool::new(true);
    let writes_while_building = AtomicU64::new(0);
    std::thread::scope(|scope| {
        let live = &mut live;
        let writing = &writing;
        let writes_while_building = &writes_while_building;
        let engine = &engine;
        scope.spawn(move || {
            for wave in 0..WAVES {
                let first = wave * WAVE_DOCUMENTS;
                let batch: Vec<Map> = (first..first + WAVE_DOCUMENTS)
                    .map(|number| document(number, number))
                    .collect();
                let result = engine
                    .insert_batch(INDEX, batch)
                    .expect("the batch completes");
                assert!(result.failed.is_empty());
                for number in first..first + WAVE_DOCUMENTS {
                    live.insert(id_of(number), vector_of(number));
                }
                for offset in 0..WAVE_DOCUMENTS {
                    let number = first + offset;
                    let changes = match offset % 5 {
                        0 => {
                            engine
                                .remove(INDEX, &id_of(number))
                                .expect("the removal succeeds");
                            live.remove(&id_of(number));
                            true
                        }
                        1 => {
                            let seed = number + UPDATE_SEED * (wave + 1);
                            engine
                                .update(INDEX, &id_of(number), document(number, seed))
                                .expect("the update succeeds");
                            live.insert(id_of(number), vector_of(seed));
                            true
                        }
                        _ => false,
                    };
                    if changes && offset % 25 < 2 && building(engine) {
                        writes_while_building.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
            writing.store(false, Ordering::Release);
        });
        for reader in 0..READERS {
            scope.spawn(move || {
                let mut round = 0u64;
                while writing.load(Ordering::Acquire) {
                    let target = vector_of(QUERY_SEED + reader * ROUND_ID_STRIDE + round);
                    let result = engine
                        .query(INDEX, &vector_query(&target))
                        .expect("the search succeeds");
                    require_consistent_hits(&target, &result);
                    round += 1;
                }
            });
        }
    });
    assert!(
        writes_while_building.load(Ordering::Relaxed) > 0,
        "no removal or update landed while the field built its graph"
    );
    settle_build(&engine);
    assert_eq!(
        engine.count_documents(INDEX).expect("the count reads"),
        live.len() as u64
    );
    for number in 0..WAVES * WAVE_DOCUMENTS {
        let stored = engine
            .get(INDEX, &id_of(number))
            .expect("the read succeeds");
        match live.get(&id_of(number)) {
            None => assert!(stored.is_none(), "doc-{number} survives its removal"),
            Some(vector) => assert_eq!(
                &vector_in(&stored.expect("the document is held")),
                vector,
                "doc-{number}"
            ),
        }
    }
    require_searches_match_oracle(&engine, &live, "after the race");
    require_graph_holds_live_documents(&engine, root.path(), &live, "after the race");
    require_searches_match_oracle(&engine, &live, "after compaction");
}

fn tell_parent(line: &str) {
    let mut out = std::io::stdout().lock();
    writeln!(out, "\n{CHILD_LINE_MARK}{line}").expect("the child writes");
    out.flush().expect("the child flushes");
}

fn announce_write(line: &str) {
    tell_parent(line);
    let mut heard = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut heard)
        .expect("the child hears the parent");
    assert_eq!(heard.trim(), CHILD_GO, "the parent lets the write go ahead");
}

fn environment_number(name: &str) -> u64 {
    std::env::var(name)
        .expect("the parent sets the variable")
        .parse()
        .expect("a number")
}

#[test]
fn vector_build_kill_child() {
    let Ok(directory) = std::env::var(CHILD_DIRECTORY) else {
        return;
    };
    let first_id = environment_number(CHILD_FIRST_ID);
    let round = environment_number(CHILD_ROUND);
    let engine = Narsil::open(durable_config(Path::new(&directory), DurabilityMode::Sync))
        .expect("the child opens");
    if engine.count_documents(INDEX).is_err() {
        engine
            .create_index(INDEX, index_config())
            .expect("the child creates the index");
    }
    for wave in 0.. {
        let first = first_id + wave * WAVE_DOCUMENTS;
        announce_write(&format!("INSERT {first} {WAVE_DOCUMENTS}"));
        let batch: Vec<Map> = (first..first + WAVE_DOCUMENTS)
            .map(|number| document(number, number))
            .collect();
        let result = engine
            .insert_batch(INDEX, batch)
            .expect("the batch completes");
        assert!(result.failed.is_empty());
        tell_parent("ACK");
        for offset in 0..WAVE_DOCUMENTS {
            let number = first + offset;
            match offset % 5 {
                0 => {
                    announce_write(&format!("REMOVE {number}"));
                    engine
                        .remove(INDEX, &id_of(number))
                        .expect("the removal succeeds");
                }
                1 => {
                    let seed = number + UPDATE_SEED * (1 + wave + ROUND_ID_STRIDE * round);
                    announce_write(&format!("UPDATE {number} {seed}"));
                    engine
                        .update(INDEX, &id_of(number), document(number, seed))
                        .expect("the update succeeds");
                }
                _ => continue,
            }
            tell_parent("ACK");
            if building(&engine) {
                tell_parent("BUILDING");
            }
        }
    }
}

#[derive(Clone)]
enum Logged {
    Insert { first: u64, count: u64 },
    Remove { number: u64 },
    Update { number: u64, seed: u64 },
}

fn parsed_write(line: &str) -> Option<Logged> {
    let mut words = line.split(' ');
    let command = words.next()?;
    if !matches!(command, "INSERT" | "REMOVE" | "UPDATE") {
        return None;
    }
    let parts: Vec<u64> = words
        .map(|part| part.parse().expect("the child writes a number"))
        .collect();
    let wanted = if command == "REMOVE" { 1 } else { 2 };
    assert_eq!(parts.len(), wanted, "the child writes {line:?}");
    Some(match command {
        "INSERT" => Logged::Insert {
            first: parts[0],
            count: parts[1],
        },
        "REMOVE" => Logged::Remove { number: parts[0] },
        _ => Logged::Update {
            number: parts[0],
            seed: parts[1],
        },
    })
}

fn apply(write: &Logged, state: &mut HashMap<u64, Option<u64>>) {
    match *write {
        Logged::Insert { first, count } => {
            for number in first..first + count {
                state.insert(number, Some(number));
            }
        }
        Logged::Remove { number } => {
            state.insert(number, None);
        }
        Logged::Update { number, seed } => {
            state.insert(number, Some(seed));
        }
    }
}

fn numbers_of(write: &Logged) -> Vec<u64> {
    match *write {
        Logged::Insert { first, count } => (first..first + count).collect(),
        Logged::Remove { number } | Logged::Update { number, .. } => vec![number],
    }
}

fn kill_mid_build(
    root: &Path,
    round: u64,
    state: &mut HashMap<u64, Option<u64>>,
) -> Option<Logged> {
    let mut child = Command::new(std::env::current_exe().expect("the test binary has a path"))
        .args([
            "--exact",
            "vector_build_kill_child",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD_DIRECTORY, root)
        .env(CHILD_FIRST_ID, (round * ROUND_ID_STRIDE).to_string())
        .env(CHILD_ROUND, round.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("the child starts");
    let stdout = child.stdout.take().expect("the child's output is piped");
    let mut go = child.stdin.take().expect("the child's input is piped");
    let mut pending: Option<Logged> = None;
    let mut acks_while_building = 0u64;
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        let Some(line) = line.strip_prefix(CHILD_LINE_MARK) else {
            continue;
        };
        if line == "ACK" {
            if let Some(write) = pending.take() {
                apply(&write, state);
            }
        } else if line == "BUILDING" {
            acks_while_building += 1;
        } else if let Some(write) = parsed_write(line) {
            pending = Some(write);
            if writeln!(go, "{CHILD_GO}")
                .and_then(|()| go.flush())
                .is_err()
            {
                break;
            }
            if acks_while_building >= ACKS_WHILE_BUILDING_BEFORE_KILL {
                break;
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    assert!(
        acks_while_building >= ACKS_WHILE_BUILDING_BEFORE_KILL,
        "round {round} heard {acks_while_building} writes during a build before the child ended"
    );
    pending
}

fn recovered_live(
    engine: &Narsil,
    state: &mut HashMap<u64, Option<u64>>,
    in_flight: Option<&Logged>,
    round: u64,
) -> HashMap<String, Vec<f32>> {
    let uncertain: HashSet<u64> = in_flight
        .map(numbers_of)
        .unwrap_or_default()
        .into_iter()
        .collect();
    let mut applied = state.clone();
    if let Some(write) = in_flight {
        apply(write, &mut applied);
    }
    let mut live = HashMap::new();
    let mut numbers: Vec<u64> = state.keys().chain(uncertain.iter()).copied().collect();
    numbers.sort_unstable();
    numbers.dedup();
    for number in numbers {
        let stored = engine
            .get(INDEX, &id_of(number))
            .expect("the read succeeds")
            .map(|document| vector_in(&document));
        let acknowledged = state.get(&number).copied().flatten().map(vector_of);
        let in_flight_state = applied.get(&number).copied().flatten().map(vector_of);
        let allowed =
            stored == acknowledged || (uncertain.contains(&number) && stored == in_flight_state);
        assert!(
            allowed,
            "round {round}: doc-{number} recovers as {stored:?}, but the acknowledged writes leave {acknowledged:?}"
        );
        if uncertain.contains(&number) {
            let seed = if stored == acknowledged {
                state.get(&number).copied().flatten()
            } else {
                applied.get(&number).copied().flatten()
            };
            state.insert(number, seed);
        }
        if let Some(vector) = stored {
            live.insert(id_of(number), vector);
        }
    }
    live
}

#[test]
fn a_kill_during_a_vector_build_recovers_every_acknowledged_write() {
    let root = ScratchDirectory::new("vector-build-kill");
    let mut state: HashMap<u64, Option<u64>> = HashMap::new();
    for round in 0..KILL_ROUNDS {
        let in_flight = kill_mid_build(root.path(), round, &mut state);
        let engine = Narsil::open(durable_config(root.path(), DurabilityMode::Sync))
            .unwrap_or_else(|error| panic!("round {round} fails to recover: {error}"));
        let live = recovered_live(&engine, &mut state, in_flight.as_ref(), round);
        assert_eq!(
            engine.count_documents(INDEX).expect("the count reads"),
            live.len() as u64,
            "round {round}"
        );
        settle_build(&engine);
        let when = format!("after kill round {round}");
        require_searches_match_oracle(&engine, &live, &when);
        require_graph_holds_live_documents(&engine, root.path(), &live, &when);
        engine.shutdown().expect("the engine shuts down");
    }
}
