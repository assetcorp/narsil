mod support;

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use narsil::{
    DurabilityConfig, DurabilityMode, DurabilityTier, ErrorCode, IndexConfig, Map,
    MemoryPersistence, Narsil, NarsilConfig, NarsilEvent, NarsilEventKind, PartitionConfig,
    QueryParams, Value,
};
use support::ScratchDirectory;

const INDEX: &str = "stories";
const WORDS: [&str; 7] = ["amber", "birch", "coral", "dune", "ember", "frost", "grove"];
const MAX_PARTITIONS: u64 = 8;
const CHILD_DIRECTORY: &str = "NARSIL_REBALANCE_CRASH_DIRECTORY";
const CHILD_START: &str = "NARSIL_REBALANCE_CRASH_START";
const SEEDED: u64 = 1_500;

fn title_of(version: u64) -> String {
    let first = WORDS[(version % 7) as usize];
    let second = WORDS[((version / 7) % 7) as usize];
    format!("{first} {second} story {version}")
}

fn document_of(version: u64) -> Map {
    let mut document = Map::new();
    document.insert("id", Value::String(format!("doc-{}", version % 2_000)));
    document.insert("title", Value::String(title_of(version)));
    document.insert("version", Value::Number(version as f64));
    document
}

fn index_config() -> IndexConfig {
    let mut schema = Map::new();
    schema.insert("title", Value::String("string".into()));
    schema.insert("version", Value::String("number".into()));
    IndexConfig {
        schema: Value::Object(schema),
        partitions: Some(PartitionConfig {
            max_partitions: Some(MAX_PARTITIONS),
            ..PartitionConfig::default()
        }),
        ..IndexConfig::default()
    }
}

fn wal_config(root: &Path) -> NarsilConfig {
    NarsilConfig {
        durability: Some(DurabilityConfig {
            directory: Some(root.to_path_buf()),
            mode: Some(DurabilityMode::Sync),
            ..DurabilityConfig::default()
        }),
        ..NarsilConfig::default()
    }
}

fn snapshot_config(adapter: Arc<MemoryPersistence>) -> NarsilConfig {
    NarsilConfig {
        durability: Some(DurabilityConfig {
            tier: Some(DurabilityTier::Snapshot),
            ..DurabilityConfig::default()
        }),
        persistence: Some(adapter),
        ..NarsilConfig::default()
    }
}

fn partition_count(narsil: &Narsil) -> usize {
    narsil
        .list_indexes()
        .into_iter()
        .find(|info| info.name == INDEX)
        .map(|info| info.partition_count)
        .expect("the index is listed")
}

fn seed(narsil: &Narsil, count: u64) -> BTreeMap<String, u64> {
    narsil
        .create_index(INDEX, index_config())
        .expect("the index is created");
    let documents = (0..count).map(document_of).collect();
    let written = narsil
        .insert_batch(INDEX, documents)
        .expect("the batch is written");
    assert!(
        written.failed.is_empty(),
        "the seed batch refused documents"
    );
    (0..count)
        .map(|version| (format!("doc-{version}"), version))
        .collect()
}

fn ids_with(model: &BTreeMap<String, u64>, word: &str) -> Vec<String> {
    model
        .iter()
        .filter(|(_, version)| title_of(**version).split(' ').any(|token| token == word))
        .map(|(id, _)| id.clone())
        .collect()
}

fn found_ids(narsil: &Narsil, word: &str) -> Vec<String> {
    let query = QueryParams {
        term: Some(word.to_string()),
        limit: Some(10_000),
        ..QueryParams::default()
    };
    let mut ids: Vec<String> = narsil
        .query(INDEX, &query)
        .expect("the search answers")
        .hits
        .into_iter()
        .map(|hit| hit.id)
        .collect();
    ids.sort();
    ids
}

fn require_agreement(narsil: &Narsil, model: &BTreeMap<String, u64>, when: &str) {
    assert_eq!(
        narsil.count_documents(INDEX).expect("the count reads"),
        model.len() as u64,
        "the count {when}"
    );
    for word in WORDS {
        assert_eq!(
            found_ids(narsil, word),
            ids_with(model, word),
            "the search for {word} {when}"
        );
    }
    let ids: Vec<String> = model.keys().cloned().collect();
    let held = narsil
        .get_multiple(INDEX, &ids)
        .expect("the documents read");
    for (id, version) in model {
        assert_eq!(held.get(id), Some(&document_of(*version)), "{id} {when}");
    }
}

#[test]
fn a_rebalance_keeps_every_document_and_holds_after_restarts() {
    let root = ScratchDirectory::new("rebalance-wal");
    let adapter = Arc::new(MemoryPersistence::new());
    let configs = [
        wal_config(root.path()),
        snapshot_config(Arc::clone(&adapter)),
    ];
    for config in configs {
        let narsil = Narsil::open(config.clone()).expect("the engine opens");
        let model = seed(&narsil, 600);
        let reported = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&reported);
        narsil.on(NarsilEventKind::PartitionRebalance, move |event| {
            if let NarsilEvent::PartitionRebalance {
                old_count,
                new_count,
                ..
            } = event
            {
                seen.lock()
                    .expect("the log locks")
                    .push((*old_count, *new_count));
            }
        });
        assert_eq!(partition_count(&narsil), MAX_PARTITIONS as usize);
        for (target, what) in [(0, "a count of 0"), (9, "a count above maxPartitions")] {
            match narsil.rebalance(INDEX, target) {
                Err(error) => assert_eq!(error.code(), ErrorCode::PARTITION_CAPACITY_EXCEEDED),
                Ok(()) => panic!("{what} was accepted"),
            }
        }
        assert!(
            narsil.rebalance("absent", 2).is_err(),
            "an absent index rebalanced"
        );
        narsil
            .rebalance(INDEX, 3)
            .expect("the rebalance to 3 succeeds");
        assert_eq!(partition_count(&narsil), 3);
        require_agreement(&narsil, &model, "after the rebalance to 3");
        narsil
            .rebalance(INDEX, 3)
            .expect("a rebalance to the same count succeeds");
        assert_eq!(*reported.lock().expect("the log locks"), vec![(8, 3)]);
        narsil.shutdown().expect("the engine shuts down");
        let reopened = Narsil::open(config.clone()).expect("the engine reopens");
        require_agreement(&reopened, &model, "after the restart");
        reopened
            .rebalance(INDEX, 5)
            .expect("the rebalance to 5 succeeds");
        reopened.shutdown().expect("the engine shuts down");
        let again = Narsil::open(config).expect("the engine reopens again");
        require_agreement(&again, &model, "after the second restart");
        again.drop_index(INDEX).expect("the index drops");
        again.shutdown().expect("the engine shuts down");
    }
}

fn written_with_retries(narsil: &Narsil, version: u64) {
    let id = format!("doc-{}", version % 2_000);
    loop {
        let outcome = if version % 5 == 4 {
            match narsil.remove(INDEX, &id) {
                Err(error) if error.code() == ErrorCode::DOC_NOT_FOUND => Ok(()),
                outcome => outcome,
            }
        } else if narsil.has(INDEX, &id).expect("the read answers") {
            narsil.update(INDEX, &id, document_of(version))
        } else {
            narsil
                .insert(INDEX, document_of(version), Some(&id))
                .map(|_| ())
        };
        match outcome {
            Err(error) if error.code() == ErrorCode::PARTITION_REBALANCING_BACKPRESSURE => continue,
            outcome => {
                outcome.expect("the write succeeds");
                return;
            }
        }
    }
}

fn applied(model: &mut BTreeMap<String, u64>, version: u64) {
    let id = format!("doc-{}", version % 2_000);
    if version % 5 == 4 {
        model.remove(&id);
    } else {
        model.insert(id, version);
    }
}

#[test]
fn writes_and_searches_during_rebalances_all_hold() {
    let root = ScratchDirectory::new("rebalance-writes");
    let narsil = Arc::new(Narsil::open(wal_config(root.path())).expect("the engine opens"));
    let mut model = seed(&narsil, SEEDED);
    let done = Arc::new(AtomicBool::new(false));
    let writer = {
        let narsil = Arc::clone(&narsil);
        let done = Arc::clone(&done);
        std::thread::spawn(move || {
            let mut version = SEEDED;
            while !done.load(Ordering::SeqCst) {
                written_with_retries(&narsil, version);
                version += 1;
            }
            version
        })
    };
    let searcher = {
        let narsil = Arc::clone(&narsil);
        let done = Arc::clone(&done);
        std::thread::spawn(move || {
            let mut searches = 0u64;
            while !done.load(Ordering::SeqCst) {
                for word in WORDS {
                    let query = QueryParams {
                        term: Some(word.to_string()),
                        ..QueryParams::default()
                    };
                    narsil
                        .query(INDEX, &query)
                        .expect("a search during a rebalance answers");
                    searches += 1;
                }
            }
            searches
        })
    };
    for target in [3, 6, 1, 8, 2] {
        narsil
            .rebalance(INDEX, target)
            .expect("the rebalance succeeds");
        assert_eq!(partition_count(&narsil), target);
    }
    done.store(true, Ordering::SeqCst);
    let last = writer.join().expect("the writer finishes");
    let searches = searcher.join().expect("the searcher finishes");
    assert!(searches > 0, "no search ran during the rebalances");
    assert!(last > SEEDED, "no write ran during the rebalances");
    for version in SEEDED..last {
        applied(&mut model, version);
    }
    require_agreement(&narsil, &model, "after the rebalances");
    narsil.shutdown().expect("the engine shuts down");
    let reopened = Narsil::open(wal_config(root.path())).expect("the engine reopens");
    require_agreement(&reopened, &model, "after the restart");
}

#[test]
fn rebalance_crash_child() {
    let (Ok(directory), Ok(start)) = (std::env::var(CHILD_DIRECTORY), std::env::var(CHILD_START))
    else {
        return;
    };
    let start: u64 = start.parse().expect("the start step parses");
    let narsil =
        Arc::new(Narsil::open(wal_config(Path::new(&directory))).expect("the child opens"));
    if narsil.count_documents(INDEX).is_err() {
        seed(&narsil, SEEDED);
    }
    let rebalancer = Arc::clone(&narsil);
    std::thread::spawn(move || {
        let mut target = 1;
        loop {
            target = target % MAX_PARTITIONS as usize + 1;
            let _ = rebalancer.rebalance(INDEX, target);
        }
    });
    let mut out = std::io::stdout().lock();
    let mut version = start;
    loop {
        written_with_retries(&narsil, version);
        writeln!(out, "ACK {version}").expect("the child writes");
        out.flush().expect("the child flushes");
        version += 1;
    }
}

fn killed_after(root: &Path, start: u64, acknowledgements: u64) -> Option<u64> {
    let mut child = Command::new(std::env::current_exe().expect("the test binary has a path"))
        .args([
            "--exact",
            "rebalance_crash_child",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD_DIRECTORY, root)
        .env(CHILD_START, start.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("the child starts");
    let stdout = child.stdout.take().expect("the child's output is piped");
    let mut last = None;
    let mut seen = 0;
    let mut lines = BufReader::new(stdout).lines();
    for line in lines.by_ref() {
        let Ok(line) = line else { break };
        if let Some(step) = line.strip_prefix("ACK ") {
            last = step.trim().parse().ok();
            seen += 1;
            if seen >= acknowledgements {
                break;
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    for line in lines {
        let Ok(line) = line else { break };
        if let Some(step) = line.strip_prefix("ACK ") {
            last = step.trim().parse().ok();
        }
    }
    last
}

#[test]
fn a_kill_during_rebalances_reopens_with_every_acknowledged_write() {
    let root = ScratchDirectory::new("rebalance-crash");
    let mut model: BTreeMap<String, u64> = (0..SEEDED)
        .map(|version| (format!("doc-{version}"), version))
        .collect();
    let mut next = SEEDED;
    for round in 0..6 {
        let Some(last) = killed_after(root.path(), next, 40 + round * 60) else {
            panic!("round {round} acknowledged no write");
        };
        for version in next..=last {
            applied(&mut model, version);
        }
        let in_flight = last + 1;
        let mut with_in_flight = model.clone();
        applied(&mut with_in_flight, in_flight);
        let narsil = Narsil::open(wal_config(root.path()))
            .unwrap_or_else(|error| panic!("round {round} fails to recover: {error}"));
        let count = partition_count(&narsil);
        assert!(
            (1..=MAX_PARTITIONS as usize).contains(&count),
            "round {round} reopened with {count} partitions"
        );
        let ids: Vec<String> = with_in_flight.keys().chain(model.keys()).cloned().collect();
        let held = narsil
            .get_multiple(INDEX, &ids)
            .expect("the documents read");
        let recovered: BTreeMap<String, u64> = held
            .iter()
            .map(|(id, document)| match document.get("version") {
                Some(Value::Number(version)) => (id.clone(), *version as u64),
                _ => panic!("{id} lost its version"),
            })
            .collect();
        let in_flight_id = format!("doc-{}", in_flight % 2_000);
        let unchanged = |left: &BTreeMap<String, u64>, right: &BTreeMap<String, u64>| {
            left.iter()
                .filter(|(id, _)| **id != in_flight_id)
                .all(|(id, version)| right.get(id) == Some(version))
        };
        assert!(
            unchanged(&model, &recovered) && unchanged(&recovered, &model),
            "round {round} recovered other documents than it acknowledged"
        );
        if recovered.get(&in_flight_id) == with_in_flight.get(&in_flight_id) {
            model = with_in_flight;
        }
        require_agreement(&narsil, &model, &format!("after crash round {round}"));
        narsil.shutdown().expect("the parent shuts down");
        next = in_flight + 1;
    }
}
