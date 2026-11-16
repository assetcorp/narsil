mod support;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use narsil::{
    DurabilityConfig, DurabilityMode, IndexConfig, Map, Narsil, NarsilConfig, PartitionConfig,
    Storage, Value,
};
use support::ScratchDirectory;

const INDEX: &str = "letters";
const BODY_WORDS: usize = 40;
const GROWTH_CHECKPOINTS: usize = 64;
const DOCUMENTS_PER_CHECKPOINT: usize = 40;
const GROWTH_COMPACTION_THRESHOLD: u32 = 2;
const LARGEST_WRITES_PER_INSERTED_BYTE: u64 = 10;
const NO_MERGE_COMPACTION_THRESHOLD: u32 = 100;
const LARGE_SEGMENT_DOCUMENTS: usize = 1_000;
const SMALL_SEGMENT_DOCUMENTS: usize = 100;
const SMALL_SEGMENT_UPDATES: usize = 90;
const LARGE_SEGMENT_UPDATES: usize = 200;
const FIRST_REPLACEMENT_SEED: usize = LARGE_SEGMENT_DOCUMENTS + SMALL_SEGMENT_DOCUMENTS;
const LARGEST_REWRITE_SHARE_OF_LARGE_SEGMENT: f64 = 0.6;
const WORDS: [&str; 8] = [
    "amber", "basalt", "copper", "dune", "estuary", "fjord", "glacier", "harbour",
];

#[derive(Clone, PartialEq, Debug)]
struct Letter {
    title: String,
    body: String,
}

fn letter_of(seed: usize) -> Letter {
    let body: Vec<String> = (0..BODY_WORDS)
        .map(|word| {
            format!(
                "{}{}",
                WORDS[(seed * 7 + word) % WORDS.len()],
                (seed * 31 + word * 17) % 4_999
            )
        })
        .collect();
    Letter {
        title: format!("letter {seed}"),
        body: body.join(" "),
    }
}

fn document_of(id: &str, letter: &Letter) -> Map {
    let mut document = Map::new();
    document.insert("id", Value::String(id.to_string()));
    document.insert("title", Value::String(letter.title.clone()));
    document.insert("body", Value::String(letter.body.clone()));
    document
}

fn config(root: &Path, threshold: u32) -> NarsilConfig {
    NarsilConfig {
        durability: Some(DurabilityConfig {
            directory: Some(root.to_path_buf()),
            mode: Some(DurabilityMode::Sync),
            checkpoint_interval_ms: Some(0),
            checkpoint_mutation_threshold: Some(1_000_000_000),
            compaction_threshold: Some(threshold),
            ..DurabilityConfig::default()
        }),
        ..NarsilConfig::default()
    }
}

fn open_with_index(root: &Path, storage: Storage, threshold: u32) -> Narsil {
    let narsil = Narsil::open(config(root, threshold)).expect("the engine opens");
    if narsil
        .list_indexes()
        .iter()
        .any(|index| index.name == INDEX)
    {
        return narsil;
    }
    let mut schema = Map::new();
    schema.insert("title", Value::String("string".into()));
    schema.insert("body", Value::String("string".into()));
    narsil
        .create_index(
            INDEX,
            IndexConfig {
                schema: Value::Object(schema),
                text_storage: Some(storage),
                partitions: Some(PartitionConfig {
                    max_partitions: Some(1),
                    ..PartitionConfig::default()
                }),
                ..IndexConfig::default()
            },
        )
        .expect("the index is created");
    narsil
}

fn collect(directory: &Path, files: &mut BTreeMap<PathBuf, u64>) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.is_dir() {
            collect(&entry.path(), files);
            continue;
        }
        if entry.file_name().to_string_lossy().contains(".tmp-") {
            continue;
        }
        files.insert(entry.path(), metadata.len());
    }
}

fn segment_files(root: &Path) -> BTreeMap<PathBuf, u64> {
    let mut files = BTreeMap::new();
    collect(&root.join(INDEX).join("segments"), &mut files);
    files
}

fn bytes_written_between(before: &BTreeMap<PathBuf, u64>, after: &BTreeMap<PathBuf, u64>) -> u64 {
    after
        .iter()
        .filter(|(path, _)| !before.contains_key(*path))
        .map(|(_, bytes)| *bytes)
        .sum()
}

fn text_of(document: &Map, field: &str) -> Option<String> {
    match document.get(field) {
        Some(Value::String(text)) => Some(text.clone()),
        _ => None,
    }
}

fn expect_letters(narsil: &Narsil, expected: &BTreeMap<String, Letter>, moment: &str) {
    assert_eq!(
        narsil.count_documents(INDEX).expect("the count reads"),
        expected.len() as u64,
        "{moment}, the index counts a different number of documents than it holds"
    );
    for (id, letter) in expected {
        let document = narsil
            .get(INDEX, id)
            .expect("the read works")
            .unwrap_or_else(|| panic!("{moment}, document {id} is missing"));
        let read = Letter {
            title: text_of(&document, "title").unwrap_or_default(),
            body: text_of(&document, "body").unwrap_or_default(),
        };
        assert_eq!(&read, letter, "{moment}, document {id} reads differently");
    }
}

fn insert_letters(
    narsil: &Narsil,
    letters: Vec<(String, Letter)>,
    expected: &mut BTreeMap<String, Letter>,
) {
    let documents = letters
        .iter()
        .map(|(id, letter)| document_of(id, letter))
        .collect();
    let written = narsil
        .insert_batch(INDEX, documents)
        .expect("the batch applies");
    assert!(written.failed.is_empty(), "every letter is written");
    expected.extend(letters);
}

fn writes_each_inserted_byte_a_few_times(storage: Storage) {
    let root = ScratchDirectory::new("checkpoint-write-cost-growth");
    let narsil = open_with_index(root.path(), storage, GROWTH_COMPACTION_THRESHOLD);
    let mut expected = BTreeMap::new();
    let mut written = 0u64;
    let mut first_written = 0u64;
    for checkpoint in 0..GROWTH_CHECKPOINTS {
        let letters = (0..DOCUMENTS_PER_CHECKPOINT)
            .map(|at| {
                (
                    format!("letter-{checkpoint}-{at}"),
                    letter_of(checkpoint * DOCUMENTS_PER_CHECKPOINT + at),
                )
            })
            .collect();
        insert_letters(&narsil, letters, &mut expected);
        let before = segment_files(root.path());
        narsil.checkpoint(INDEX).expect("the checkpoint commits");
        written += bytes_written_between(&before, &segment_files(root.path()));
        if checkpoint == 0 {
            first_written = written;
        }
    }
    assert!(
        first_written > 0,
        "the first checkpoint wrote no segment file"
    );
    let inserted = first_written * GROWTH_CHECKPOINTS as u64;
    assert!(
        written <= inserted * LARGEST_WRITES_PER_INSERTED_BYTE,
        "{GROWTH_CHECKPOINTS} checkpoints wrote {written} bytes of segment files, {:.1} times the bytes that they inserted, above the limit of {LARGEST_WRITES_PER_INSERTED_BYTE} times",
        written as f64 / inserted as f64
    );
    expect_letters(&narsil, &expected, "before the restart");
    narsil.shutdown().expect("the engine shuts down");
    let narsil = open_with_index(root.path(), storage, GROWTH_COMPACTION_THRESHOLD);
    expect_letters(&narsil, &expected, "after the restart");
    narsil.shutdown().expect("the engine shuts down");
}

fn rewrites_the_highest_replaced_share_first(storage: Storage) {
    let root = ScratchDirectory::new("checkpoint-write-cost-rewrite");
    let narsil = open_with_index(root.path(), storage, NO_MERGE_COMPACTION_THRESHOLD);
    let mut expected = BTreeMap::new();
    let large = (0..LARGE_SEGMENT_DOCUMENTS)
        .map(|at| (format!("large-{at}"), letter_of(at)))
        .collect();
    insert_letters(&narsil, large, &mut expected);
    narsil.checkpoint(INDEX).expect("the checkpoint commits");
    let large_bytes: u64 = segment_files(root.path()).values().sum();
    let small = (0..SMALL_SEGMENT_DOCUMENTS)
        .map(|at| {
            (
                format!("small-{at}"),
                letter_of(LARGE_SEGMENT_DOCUMENTS + at),
            )
        })
        .collect();
    insert_letters(&narsil, small, &mut expected);
    narsil.checkpoint(INDEX).expect("the checkpoint commits");

    let ids: Vec<String> = (0..SMALL_SEGMENT_UPDATES)
        .map(|at| format!("small-{at}"))
        .chain((0..LARGE_SEGMENT_UPDATES).map(|at| format!("large-{at}")))
        .collect();
    let distinct: BTreeSet<&String> = ids.iter().collect();
    assert_eq!(
        distinct.len(),
        ids.len(),
        "every update names another document"
    );
    let updates = ids
        .iter()
        .enumerate()
        .map(|(at, id)| {
            let letter = letter_of(FIRST_REPLACEMENT_SEED + at);
            let document = document_of(id, &letter);
            expected.insert(id.clone(), letter);
            (id.clone(), document)
        })
        .collect();
    let outcome = narsil
        .update_batch(INDEX, updates)
        .expect("the updates apply");
    assert!(outcome.failed.is_empty(), "every update applies");
    let before = segment_files(root.path());
    narsil.checkpoint(INDEX).expect("the checkpoint commits");
    let written = bytes_written_between(&before, &segment_files(root.path()));
    let limit = large_bytes as f64 * LARGEST_REWRITE_SHARE_OF_LARGE_SEGMENT;
    assert!(
        (written as f64) < limit,
        "the checkpoint after the updates wrote {written} bytes of segment files, at or above {limit:.0}, so it rewrote the {large_bytes}-byte segment that holds the smaller share of replaced documents"
    );
    expect_letters(&narsil, &expected, "before the restart");
    narsil.shutdown().expect("the engine shuts down");
    let narsil = open_with_index(root.path(), storage, NO_MERGE_COMPACTION_THRESHOLD);
    expect_letters(&narsil, &expected, "after the restart");
    narsil.shutdown().expect("the engine shuts down");
}

#[test]
fn checkpoints_write_each_inserted_byte_a_few_times_with_text_in_memory() {
    writes_each_inserted_byte_a_few_times(Storage::Memory);
}

#[test]
fn checkpoints_write_each_inserted_byte_a_few_times_with_text_on_disk() {
    writes_each_inserted_byte_a_few_times(Storage::Disk);
}

#[test]
fn a_checkpoint_rewrites_the_segment_with_the_highest_replaced_share_first_with_text_in_memory() {
    rewrites_the_highest_replaced_share_first(Storage::Memory);
}

#[test]
fn a_checkpoint_rewrites_the_segment_with_the_highest_replaced_share_first_with_text_on_disk() {
    rewrites_the_highest_replaced_share_first(Storage::Disk);
}
