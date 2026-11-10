mod support;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use narsil::{
    DurabilityConfig, DurabilityMode, IndexConfig, Map, Narsil, NarsilConfig, QueryParams, Storage,
    Value, parse_json, write_json,
};
use support::{ScratchDirectory, repository_root};

const INDEX: &str = "notes";
const WORDS: [&str; 5] = ["amber", "basalt", "copper", "dune", "estuary"];
const PAGED_SEGMENT_ENVELOPE_VERSION: u8 = 6;
const ENVELOPE_VERSION_BYTE: usize = 4;
const ROUNDS: u64 = 8;
const WRITES_PER_ROUND: u64 = 45;
const COMPACTION_THRESHOLD: u32 = 3;

fn config(root: &Path) -> NarsilConfig {
    NarsilConfig {
        durability: Some(DurabilityConfig {
            directory: Some(root.to_path_buf()),
            mode: Some(DurabilityMode::Sync),
            compaction_threshold: Some(COMPACTION_THRESHOLD),
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

fn title_of(version: u64) -> String {
    let first = WORDS[(version % 5) as usize];
    let second = WORDS[((version / 5) % 5) as usize];
    format!("{first} {second} note {version}")
}

fn document_of(version: u64) -> Map {
    let mut document = Map::new();
    document.insert("title", Value::String(title_of(version)));
    document.insert("version", Value::Number(version as f64));
    document
}

enum Change {
    Put(String, u64),
    Remove(String),
}

fn change_at(step: u64) -> Change {
    if step % 9 == 8 {
        return Change::Remove(format!("doc-{}", step / 3));
    }
    if step % 4 == 3 {
        return Change::Put(format!("doc-{}", step / 2), step);
    }
    Change::Put(format!("doc-{step}"), step)
}

fn write(narsil: &Narsil, model: &mut BTreeMap<String, u64>, step: u64) {
    match change_at(step) {
        Change::Put(id, version) => {
            if model.contains_key(&id) {
                narsil
                    .update(INDEX, &id, document_of(version))
                    .expect("the update succeeds");
            } else {
                narsil
                    .insert(INDEX, document_of(version), Some(&id))
                    .expect("the insert succeeds");
            }
            model.insert(id, version);
        }
        Change::Remove(id) => {
            if model.remove(&id).is_some() {
                narsil.remove(INDEX, &id).expect("the removal succeeds");
            }
        }
    }
}

fn require_agrees(narsil: &Narsil, model: &BTreeMap<String, u64>, steps: u64, label: &str) {
    let candidates: Vec<String> = (0..steps).map(|step| format!("doc-{step}")).collect();
    let held = narsil
        .get_multiple(INDEX, &candidates)
        .expect("the documents read");
    let wanted: BTreeMap<String, Map> = model
        .iter()
        .map(|(id, version)| (id.clone(), document_of(*version)))
        .collect();
    assert_eq!(held, wanted, "the stored documents {label}");
    let count = narsil.count_documents(INDEX).expect("the count reads");
    assert_eq!(count, model.len() as u64, "the document count {label}");
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
        assert_eq!(ids, wanted, "the search for {word} {label}");
    }
}

fn fields_of(document: &Value) -> Option<(String, f64)> {
    let Value::Object(document) = document else {
        return None;
    };
    match (document.get("title"), document.get("version")) {
        (Some(Value::String(title)), Some(Value::Number(version))) if document.len() == 2 => {
            Some((title.clone(), *version))
        }
        _ => None,
    }
}

fn require_reference_reads(root: &Path, model: &BTreeMap<String, u64>, steps: u64) {
    let candidates: Vec<Value> = (0..steps)
        .map(|step| Value::String(format!("doc-{step}")))
        .collect();
    let words: Vec<Value> = WORDS
        .iter()
        .map(|word| Value::String(word.to_string()))
        .collect();
    let script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/reference_directory.mjs");
    let output = Command::new("node")
        .arg(script)
        .arg(repository_root())
        .arg(root)
        .arg(INDEX)
        .arg(write_json(&Value::Array(candidates)))
        .arg(write_json(&Value::Array(words)))
        .output()
        .expect("node runs the TypeScript reference");
    assert!(
        output.status.success(),
        "the TypeScript reference refused the directory; build packages/ts first: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout).expect("the reference writes UTF-8");
    let read = parse_json(&text).expect("the reference writes JSON");
    let Some(Value::Object(documents)) = read.pointer("documents") else {
        panic!("the reference listed no documents: {text}");
    };
    let held: BTreeMap<String, Option<(String, f64)>> = documents
        .iter()
        .map(|(id, document)| (id.clone(), fields_of(document)))
        .collect();
    let wanted: BTreeMap<String, Option<(String, f64)>> = model
        .iter()
        .map(|(id, version)| (id.clone(), Some((title_of(*version), *version as f64))))
        .collect();
    assert_eq!(held, wanted, "the documents that the reference reads");
    assert_eq!(
        read.pointer("count"),
        Some(&Value::Number(model.len() as f64)),
        "the count that the reference reads"
    );
    for word in WORDS {
        let found = match read.pointer(&format!("searches.{word}")) {
            Some(Value::Array(ids)) => ids.clone(),
            _ => panic!("the reference ran no search for {word}"),
        };
        let wanted: Vec<Value> = model
            .iter()
            .filter(|(_, version)| title_of(**version).split(' ').any(|token| token == word))
            .map(|(id, _)| Value::String(id.clone()))
            .collect();
        assert_eq!(found, wanted, "the reference's search for {word}");
    }
}

fn files_under(directory: &Path, found: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            files_under(&path, found);
        } else {
            found.push(path);
        }
    }
}

fn write_rounds_with_reopens(root: &Path, storage: Storage) -> (BTreeMap<String, u64>, u64) {
    let mut model = BTreeMap::new();
    let mut narsil = Narsil::open(config(root)).expect("the engine opens");
    narsil
        .create_index(INDEX, index_config(storage))
        .expect("the index is created");
    let mut step = 0;
    for round in 0..ROUNDS {
        for _ in 0..WRITES_PER_ROUND {
            write(&narsil, &mut model, step);
            step += 1;
        }
        narsil.checkpoint(INDEX).expect("the checkpoint commits");
        require_agrees(
            &narsil,
            &model,
            step,
            &format!("after the checkpoint of round {round}"),
        );
        if round % 2 == 1 {
            narsil.shutdown().expect("the engine shuts down");
            narsil = Narsil::open(config(root)).expect("the engine reopens");
            require_agrees(
                &narsil,
                &model,
                step,
                &format!("after the reopen of round {round}"),
            );
        }
    }
    narsil.shutdown().expect("the engine shuts down");
    (model, step)
}

fn segment_files(root: &Path) -> Vec<PathBuf> {
    let mut segments = Vec::new();
    files_under(&root.join(INDEX).join("segments"), &mut segments);
    assert!(!segments.is_empty(), "the checkpoints wrote no segment");
    segments
}

#[test]
fn a_memory_text_index_merges_segments_past_the_threshold_and_keeps_every_write() {
    let root = ScratchDirectory::new("merged-text");
    let (model, step) = write_rounds_with_reopens(root.path(), Storage::Memory);
    let segments = segment_files(root.path());
    assert!(
        segments.len() <= COMPACTION_THRESHOLD as usize,
        "the partition kept {} segment files past the threshold of {COMPACTION_THRESHOLD}",
        segments.len()
    );
    require_reference_reads(root.path(), &model, step);
}

#[test]
fn a_disk_text_index_keeps_every_write_across_checkpoints_merges_and_reopens() {
    let root = ScratchDirectory::new("paged-text");
    let (model, step) = write_rounds_with_reopens(root.path(), Storage::Disk);
    let segments = segment_files(root.path());
    assert!(
        segments.len() <= COMPACTION_THRESHOLD as usize,
        "the partition kept {} segment files past the threshold of {COMPACTION_THRESHOLD}",
        segments.len()
    );
    for path in segments {
        let bytes = std::fs::read(&path).expect("the segment file reads");
        assert_eq!(
            bytes.get(ENVELOPE_VERSION_BYTE).copied(),
            Some(PAGED_SEGMENT_ENVELOPE_VERSION),
            "{} is not a paged segment",
            path.display()
        );
    }
    require_reference_reads(root.path(), &model, step);
}
