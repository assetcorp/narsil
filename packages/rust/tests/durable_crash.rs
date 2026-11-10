mod support;

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};

use narsil::{
    DurabilityConfig, DurabilityMode, IndexConfig, Map, Narsil, NarsilConfig, QueryParams,
    SearchMode, Value, VectorQuery,
};
use support::ScratchDirectory;

const CHILD_DIRECTORY: &str = "NARSIL_CRASH_DIRECTORY";
const CHILD_PLAN: &str = "NARSIL_CRASH_PLAN";
const CHILD_START: &str = "NARSIL_CRASH_START";
const INDEX: &str = "events";
const WORDS: [&str; 6] = ["alpha", "bravo", "cedar", "delta", "ember", "fjord"];
const ROUNDS: u64 = 12;
const DIMENSION: usize = 4;

#[derive(Clone, Copy)]
enum Plan {
    Inserts,
    Checkpoints,
    Merges,
}

impl Plan {
    fn name(self) -> &'static str {
        match self {
            Plan::Inserts => "inserts",
            Plan::Checkpoints => "checkpoints",
            Plan::Merges => "merges",
        }
    }

    fn named(name: &str) -> Plan {
        match name {
            "checkpoints" => Plan::Checkpoints,
            "merges" => Plan::Merges,
            _ => Plan::Inserts,
        }
    }

    fn config(self, root: &Path) -> NarsilConfig {
        let (threshold, compaction) = match self {
            Plan::Inserts => (None, None),
            Plan::Checkpoints => (Some(13), None),
            Plan::Merges => (Some(7), Some(1)),
        };
        NarsilConfig {
            durability: Some(DurabilityConfig {
                directory: Some(root.to_path_buf()),
                mode: Some(DurabilityMode::Sync),
                checkpoint_mutation_threshold: threshold,
                compaction_threshold: compaction,
                ..DurabilityConfig::default()
            }),
            ..NarsilConfig::default()
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Operation {
    Put(String, u64),
    Remove(String),
}

fn operation(step: u64) -> Operation {
    if step % 11 == 10 && step >= 5 {
        return Operation::Remove(format!("doc-{}", step - 5));
    }
    if step % 7 == 6 && step >= 3 {
        return Operation::Put(format!("doc-{}", step - 3), step);
    }
    Operation::Put(format!("doc-{step}"), step)
}

fn title_of(version: u64) -> String {
    let first = WORDS[(version % 6) as usize];
    let second = WORDS[((version / 6) % 6) as usize];
    format!("{first} {second} event {version}")
}

fn embedding_of(version: u64) -> Vec<f64> {
    (0..DIMENSION)
        .map(|at| (((version * 31 + at as u64 * 17) % 97) as f64 - 48.0) / 64.0)
        .collect()
}

fn document_of(version: u64) -> Map {
    let mut document = Map::new();
    document.insert("title", Value::String(title_of(version)));
    document.insert("version", Value::Number(version as f64));
    let embedding = embedding_of(version)
        .into_iter()
        .map(|value| Value::Number(f64::from(value as f32)))
        .collect();
    document.insert("embedding", Value::Array(embedding));
    document
}

fn index_config() -> IndexConfig {
    let mut schema = Map::new();
    schema.insert("title", Value::String("string".into()));
    schema.insert("version", Value::String("number".into()));
    schema.insert("embedding", Value::String(format!("vector[{DIMENSION}]")));
    IndexConfig {
        schema: Value::Object(schema),
        ..IndexConfig::default()
    }
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
fn crash_child_writer() {
    let (Ok(directory), Ok(plan), Ok(start)) = (
        std::env::var(CHILD_DIRECTORY),
        std::env::var(CHILD_PLAN),
        std::env::var(CHILD_START),
    ) else {
        return;
    };
    let start: u64 = start.parse().expect("the start step parses");
    let narsil =
        Narsil::open(Plan::named(&plan).config(Path::new(&directory))).expect("the child opens");
    if narsil.count_documents(INDEX).is_err() {
        narsil
            .create_index(INDEX, index_config())
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

fn killed_after(root: &Path, plan: Plan, start: u64, acknowledgements: u64) -> Option<u64> {
    let mut child = Command::new(std::env::current_exe().expect("the test binary has a path"))
        .args([
            "--exact",
            "crash_child_writer",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD_DIRECTORY, root)
        .env(CHILD_PLAN, plan.name())
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

fn recovered_versions(narsil: &Narsil, candidates: &[String]) -> BTreeMap<String, u64> {
    let held = narsil
        .get_multiple(INDEX, candidates)
        .expect("the recovered documents read");
    held.into_iter()
        .map(|(id, document)| {
            let version = match document.get("version") {
                Some(Value::Number(number)) => *number as u64,
                _ => panic!("{id} lost its version"),
            };
            assert_eq!(
                document,
                document_of(version),
                "{id} holds other content than version {version}"
            );
            (id, version)
        })
        .collect()
}

fn require_searches_agree(narsil: &Narsil, model: &BTreeMap<String, u64>) {
    for word in WORDS {
        let query = QueryParams {
            term: Some(word.to_string()),
            limit: Some(10_000),
            ..QueryParams::default()
        };
        let found = narsil
            .query(INDEX, &query)
            .expect("the term search answers");
        let mut ids: Vec<String> = found.hits.into_iter().map(|hit| hit.id).collect();
        ids.sort();
        let wanted: Vec<String> = model
            .iter()
            .filter(|(_, version)| title_of(**version).split(' ').any(|token| token == word))
            .map(|(id, _)| id.clone())
            .collect();
        assert_eq!(ids, wanted, "the search for {word} after recovery");
    }
    let query = QueryParams {
        mode: Some(SearchMode::Vector),
        limit: Some(10_000),
        vector: Some(VectorQuery {
            field: "embedding".into(),
            value: Some(vec![1.0, 0.0, 0.0, 0.0]),
            text: None,
            similarity: None,
            metric: None,
            ef_search: Some(10_000),
            oversample: None,
        }),
        ..QueryParams::default()
    };
    let found = narsil
        .query(INDEX, &query)
        .expect("the vector search answers");
    let mut ids: Vec<String> = found.hits.into_iter().map(|hit| hit.id).collect();
    ids.sort();
    let wanted: Vec<String> = model.keys().cloned().collect();
    let missing: Vec<&String> = wanted.iter().filter(|id| !ids.contains(id)).collect();
    let extra: Vec<&String> = ids.iter().filter(|id| !wanted.contains(id)).collect();
    assert!(
        missing.is_empty() && extra.is_empty(),
        "the vector search after recovery returns every document: missing {missing:?} extra {extra:?} of {}",
        wanted.len()
    );
}

fn crash_rounds(plan: Plan) {
    let root = ScratchDirectory::new(&format!("crash-{}", plan.name()));
    let mut model = BTreeMap::new();
    let mut next = 0;
    for round in 0..ROUNDS {
        let wanted = 30 + round * 41;
        let Some(last) = killed_after(root.path(), plan, next, wanted) else {
            panic!("round {round} of {} acknowledged no write", plan.name());
        };
        for step in next..=last {
            apply(&mut model, step);
        }
        let in_flight = last + 1;
        let mut with_in_flight = model.clone();
        apply(&mut with_in_flight, in_flight);
        let candidates: Vec<String> = (0..=in_flight).map(|step| format!("doc-{step}")).collect();
        let narsil = Narsil::open(plan.config(root.path())).unwrap_or_else(|error| {
            panic!("{} round {round} fails to recover: {error}", plan.name())
        });
        let recovered = recovered_versions(&narsil, &candidates);
        let count = narsil.count_documents(INDEX).expect("the count reads");
        if recovered == with_in_flight {
            model = with_in_flight;
        } else if recovered != model {
            let differing: Vec<String> = candidates
                .iter()
                .filter(|id| recovered.get(*id) != model.get(*id))
                .map(|id| {
                    format!(
                        "{id}: recovered {:?}, acknowledged {:?}",
                        recovered.get(id),
                        model.get(id)
                    )
                })
                .collect();
            panic!(
                "{} round {round} (steps {next}..={last}, in flight {in_flight:?}) recovered other documents:\n{}",
                plan.name(),
                differing.join("\n")
            );
        }
        assert_eq!(
            count,
            model.len() as u64,
            "{} round {round} counts other documents",
            plan.name()
        );
        require_searches_agree(&narsil, &model);
        narsil.shutdown().expect("the parent shuts down");
        next = in_flight + 1;
    }
    let segments = std::fs::read_dir(root.path().join(INDEX).join("segments"))
        .map(|entries| entries.count())
        .unwrap_or(0);
    let checkpointed = root.path().join(INDEX).join("manifest").exists();
    match plan {
        Plan::Inserts => {}
        Plan::Checkpoints | Plan::Merges => {
            assert!(
                checkpointed && segments > 0,
                "{} wrote no checkpoint",
                plan.name()
            );
        }
    }
}

#[test]
fn a_kill_during_inserts_keeps_every_acknowledged_write() {
    crash_rounds(Plan::Inserts);
}

#[test]
fn a_kill_during_frequent_checkpoints_keeps_every_acknowledged_write() {
    crash_rounds(Plan::Checkpoints);
}

#[test]
fn a_kill_during_segment_merges_keeps_every_acknowledged_write() {
    crash_rounds(Plan::Merges);
}
