mod support;

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};

use narsil::{
    DurabilityConfig, DurabilityMode, IndexConfig, Map, Narsil, NarsilConfig, QueryParams, Storage,
    Value,
};
use support::ScratchDirectory;

const CHILD_DIRECTORY: &str = "NARSIL_REWRITE_CRASH_DIRECTORY";
const CHILD_STORAGE: &str = "NARSIL_REWRITE_CRASH_STORAGE";
const CHILD_START: &str = "NARSIL_REWRITE_CRASH_START";
const INDEX: &str = "tickets";
const WORDS: [&str; 4] = ["harbour", "lantern", "meadow", "quarry"];
const ID_POOL: u64 = 40;
const ROUNDS: u64 = 10;
const CHECKPOINT_INTERVAL_MS: u64 = 15;
const CHECKPOINT_MUTATIONS: u64 = 9;

fn storage_named(name: &str) -> Storage {
    match name {
        "disk" => Storage::Disk,
        _ => Storage::Memory,
    }
}

fn config(root: &Path) -> NarsilConfig {
    NarsilConfig {
        durability: Some(DurabilityConfig {
            directory: Some(root.to_path_buf()),
            mode: Some(DurabilityMode::Sync),
            checkpoint_interval_ms: Some(CHECKPOINT_INTERVAL_MS),
            checkpoint_mutation_threshold: Some(CHECKPOINT_MUTATIONS),
            ..DurabilityConfig::default()
        }),
        ..NarsilConfig::default()
    }
}

fn index_config(storage: Storage) -> IndexConfig {
    let mut schema = Map::new();
    schema.insert("title", Value::String("string".into()));
    schema.insert("version", Value::String("number".into()));
    IndexConfig {
        schema: Value::Object(schema),
        text_storage: Some(storage),
        ..IndexConfig::default()
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Operation {
    Put(String, u64),
    Remove(String),
}

fn operation(step: u64) -> Operation {
    let id = format!("ticket-{}", (step * 13) % ID_POOL);
    if step % 3 == 2 {
        Operation::Remove(id)
    } else {
        Operation::Put(id, step)
    }
}

fn title_of(version: u64) -> String {
    let first = WORDS[(version % 4) as usize];
    let second = WORDS[((version / 4) % 4) as usize];
    format!("{first} {second} ticket {version}")
}

fn document_of(version: u64) -> Map {
    let mut document = Map::new();
    document.insert("title", Value::String(title_of(version)));
    document.insert("version", Value::Number(version as f64));
    document
}

fn apply(model: &mut BTreeMap<String, u64>, step: u64) {
    match operation(step) {
        Operation::Put(id, version) => {
            model.insert(id, version);
        }
        Operation::Remove(id) => {
            model.remove(&id);
        }
    }
}

fn run_operation(narsil: &Narsil, step: u64) -> narsil::Result<()> {
    match operation(step) {
        Operation::Put(id, version) => {
            if narsil.has(INDEX, &id)? {
                narsil.update(INDEX, &id, document_of(version))
            } else {
                narsil
                    .insert(INDEX, document_of(version), Some(&id))
                    .map(|_| ())
            }
        }
        Operation::Remove(id) => match narsil.remove(INDEX, &id) {
            Err(error) if error.code().as_str() == "DOC_NOT_FOUND" => Ok(()),
            outcome => outcome,
        },
    }
}

#[test]
fn rewrite_crash_child_writer() {
    let (Ok(directory), Ok(storage), Ok(start)) = (
        std::env::var(CHILD_DIRECTORY),
        std::env::var(CHILD_STORAGE),
        std::env::var(CHILD_START),
    ) else {
        return;
    };
    let start: u64 = start.parse().expect("the start step parses");
    let narsil = Narsil::open(config(Path::new(&directory))).expect("the child opens");
    if narsil.count_documents(INDEX).is_err() {
        narsil
            .create_index(INDEX, index_config(storage_named(&storage)))
            .expect("the child creates the index");
    }
    let mut out = std::io::stdout().lock();
    writeln!(out, "READY").expect("the child writes");
    out.flush().expect("the child flushes");
    let mut step = start;
    loop {
        run_operation(&narsil, step).expect("the child's write succeeds");
        writeln!(out, "ACK {step}").expect("the child writes");
        out.flush().expect("the child flushes");
        step += 1;
    }
}

fn killed_after(root: &Path, storage: &str, start: u64, acknowledgements: u64) -> Option<u64> {
    let mut child = Command::new(std::env::current_exe().expect("the test binary has a path"))
        .args([
            "--exact",
            "rewrite_crash_child_writer",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD_DIRECTORY, root)
        .env(CHILD_STORAGE, storage)
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

fn recovered_versions(narsil: &Narsil) -> BTreeMap<String, u64> {
    let candidates: Vec<String> = (0..ID_POOL).map(|at| format!("ticket-{at}")).collect();
    narsil
        .get_multiple(INDEX, &candidates)
        .expect("the recovered documents read")
        .into_iter()
        .map(|(id, document)| {
            let version = match document.get("version") {
                Some(Value::Number(number)) => *number as u64,
                _ => panic!("{id} lost its version"),
            };
            assert_eq!(document, document_of(version), "{id} holds other content");
            (id, version)
        })
        .collect()
}

fn require_searches_agree(narsil: &Narsil, model: &BTreeMap<String, u64>, round: u64) {
    for word in WORDS {
        let query = QueryParams {
            term: Some(word.to_string()),
            limit: Some(10_000),
            ..QueryParams::default()
        };
        let found = narsil.query(INDEX, &query).expect("the search answers");
        let mut ids: Vec<String> = found.hits.into_iter().map(|hit| hit.id).collect();
        ids.sort();
        let wanted: Vec<String> = model
            .iter()
            .filter(|(_, version)| title_of(**version).split(' ').any(|token| token == word))
            .map(|(id, _)| id.clone())
            .collect();
        assert_eq!(ids, wanted, "round {round}: the search for {word}");
    }
}

fn crash_rounds(storage: &str) {
    let root = ScratchDirectory::new(&format!("rewrite-crash-{storage}"));
    let mut model = BTreeMap::new();
    let mut next = 0;
    for round in 0..ROUNDS {
        let wanted = 25 + round * 37;
        let Some(last) = killed_after(root.path(), storage, next, wanted) else {
            panic!("round {round} acknowledged no write");
        };
        for step in next..=last {
            apply(&mut model, step);
        }
        let in_flight = last + 1;
        let mut with_in_flight = model.clone();
        apply(&mut with_in_flight, in_flight);
        let narsil = Narsil::open(config(root.path()))
            .unwrap_or_else(|error| panic!("round {round} fails to recover: {error}"));
        let recovered = recovered_versions(&narsil);
        if recovered == with_in_flight {
            model = with_in_flight;
        } else {
            assert_eq!(
                recovered, model,
                "round {round} (steps {next}..={last}) recovered other documents"
            );
        }
        assert_eq!(
            narsil.count_documents(INDEX).expect("the count reads"),
            model.len() as u64,
            "round {round} counts other documents"
        );
        require_searches_agree(&narsil, &model, round);
        narsil.shutdown().expect("the parent shuts down");
        next = in_flight + 1;
    }
}

#[test]
fn a_kill_during_removed_document_rewrites_keeps_every_acknowledged_write() {
    crash_rounds("memory");
}

#[test]
fn a_kill_during_paged_removed_document_rewrites_keeps_every_acknowledged_write() {
    crash_rounds("disk");
}
