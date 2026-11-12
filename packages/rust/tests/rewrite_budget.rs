mod support;

use std::collections::BTreeMap;
use std::path::Path;

use narsil::{
    DurabilityConfig, DurabilityMode, ErrorCode, IndexConfig, Map, Narsil, NarsilConfig,
    PartitionConfig, Storage, Value,
};
use support::ScratchDirectory;

const INDEX: &str = "letters";
const PARTITIONS: usize = 8;
const ROUNDS: usize = 10;
const DOCUMENTS_PER_ROUND: usize = 320;
const BODY_WORDS: usize = 40;
const REWRITE_BYTES: u64 = 4_096;
const MEASURED_CHECKPOINTS: usize = 5;
const SEGMENT_ID_DIGITS: usize = 16;
const WORDS: [&str; 6] = ["amber", "basalt", "copper", "dune", "estuary", "fjord"];

fn config(root: &Path, rewrite_bytes: Option<u64>) -> NarsilConfig {
    NarsilConfig {
        durability: Some(DurabilityConfig {
            directory: Some(root.to_path_buf()),
            mode: Some(DurabilityMode::Sync),
            checkpoint_interval_ms: Some(0),
            checkpoint_mutation_threshold: Some(1_000_000_000),
            rewrite_bytes_per_checkpoint: rewrite_bytes,
            ..DurabilityConfig::default()
        }),
        ..NarsilConfig::default()
    }
}

fn id_of(round: usize, at: usize) -> String {
    format!("letter-{round}-{at}")
}

fn letter_of(round: usize, at: usize) -> Map {
    let seed = round * DOCUMENTS_PER_ROUND + at;
    let body: Vec<String> = (0..BODY_WORDS)
        .map(|word| {
            format!(
                "{}{}",
                WORDS[(seed + word) % WORDS.len()],
                (seed * 31 + word) % 997
            )
        })
        .collect();
    let mut document = Map::new();
    document.insert("id", Value::String(id_of(round, at)));
    document.insert("title", Value::String(format!("letter {round} {at}")));
    document.insert("body", Value::String(body.join(" ")));
    document
}

struct PartitionFiles {
    segments: BTreeMap<String, u64>,
    bytes: u64,
}

impl PartitionFiles {
    fn new_segments(&self, before: &PartitionFiles) -> usize {
        self.segments
            .keys()
            .filter(|id| !before.segments.contains_key(*id))
            .count()
    }
}

fn segment_id_of(name: &str) -> Option<String> {
    let digits = name.strip_prefix('s')?.get(..SEGMENT_ID_DIGITS)?;
    digits
        .bytes()
        .all(|byte| byte.is_ascii_digit())
        .then(|| digits.to_string())
}

fn collect(directory: &Path, files: &mut PartitionFiles) {
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
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.contains(".tmp-") {
            continue;
        }
        files.bytes += metadata.len();
        if let Some(id) = segment_id_of(&name) {
            *files.segments.entry(id).or_default() += metadata.len();
        }
    }
}

fn partition_files(root: &Path) -> Vec<PartitionFiles> {
    (0..PARTITIONS)
        .map(|partition| {
            let mut files = PartitionFiles {
                segments: BTreeMap::new(),
                bytes: 0,
            };
            collect(
                &root
                    .join(INDEX)
                    .join("segments")
                    .join(partition.to_string()),
                &mut files,
            );
            files
        })
        .collect()
}

fn shrinks_every_partition_one_segment_at_a_time(storage: Storage) {
    let root = ScratchDirectory::new("rewrite-budget");
    let narsil = Narsil::open(config(root.path(), Some(REWRITE_BYTES))).expect("the engine opens");
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
                    max_partitions: Some(PARTITIONS as u64),
                    ..PartitionConfig::default()
                }),
                ..IndexConfig::default()
            },
        )
        .expect("the index is created");
    for round in 0..ROUNDS {
        let letters = (0..DOCUMENTS_PER_ROUND)
            .map(|at| letter_of(round, at))
            .collect();
        let written = narsil
            .insert_batch(INDEX, letters)
            .expect("the batch applies");
        assert!(written.failed.is_empty(), "every letter is written");
        narsil.checkpoint(INDEX).expect("the checkpoint commits");
    }
    for (partition, files) in partition_files(root.path()).iter().enumerate() {
        assert_eq!(
            files.segments.len(),
            ROUNDS,
            "partition {partition} holds one segment per round"
        );
        assert!(
            files.segments.values().all(|bytes| *bytes > REWRITE_BYTES),
            "every segment of partition {partition} is larger than the budget, so the budget alone admits none"
        );
    }
    let removed: Vec<String> = (0..ROUNDS)
        .flat_map(|round| {
            (0..DOCUMENTS_PER_ROUND)
                .step_by(2)
                .map(move |at| id_of(round, at))
        })
        .collect();
    let outcome = narsil
        .remove_batch(INDEX, removed.clone())
        .expect("the removals apply");
    assert!(outcome.failed.is_empty(), "every removal applies");
    narsil.checkpoint(INDEX).expect("the checkpoint commits");

    for step in 0..MEASURED_CHECKPOINTS {
        let before = partition_files(root.path());
        narsil.checkpoint(INDEX).expect("the checkpoint commits");
        let after = partition_files(root.path());
        for (partition, (before, after)) in before.iter().zip(&after).enumerate() {
            let written = after.new_segments(before);
            assert_eq!(
                written, 1,
                "checkpoint {step} wrote {written} segments for partition {partition}, while a budget of {REWRITE_BYTES} bytes allows its one guaranteed rewrite"
            );
            assert!(
                after.bytes < before.bytes,
                "checkpoint {step} left partition {partition} at {} bytes, from {}",
                after.bytes,
                before.bytes
            );
        }
    }

    let live = (ROUNDS * DOCUMENTS_PER_ROUND - removed.len()) as u64;
    assert_eq!(
        narsil.count_documents(INDEX).expect("the count reads"),
        live
    );
    assert!(
        narsil
            .get(INDEX, &id_of(3, 1))
            .expect("the read works")
            .is_some()
    );
    assert!(
        narsil
            .get(INDEX, &id_of(3, 2))
            .expect("the read works")
            .is_none()
    );
    narsil.shutdown().expect("the engine shuts down");
}

#[test]
fn a_small_rewrite_budget_still_shrinks_every_partition_with_text_in_memory() {
    shrinks_every_partition_one_segment_at_a_time(Storage::Memory);
}

#[test]
fn a_small_rewrite_budget_still_shrinks_every_partition_with_text_on_disk() {
    shrinks_every_partition_one_segment_at_a_time(Storage::Disk);
}

#[test]
fn a_rewrite_budget_of_zero_refuses_the_open() {
    let root = ScratchDirectory::new("rewrite-budget-zero");
    match Narsil::open(config(root.path(), Some(0))) {
        Ok(_) => panic!("the engine opened with a rewrite budget of zero"),
        Err(refused) => assert_eq!(refused.code(), ErrorCode::CONFIG_INVALID),
    }
}
