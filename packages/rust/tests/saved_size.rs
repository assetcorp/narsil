mod support;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use narsil::{
    DurabilityConfig, DurabilityMode, IndexConfig, IndexLifecycleConfig, Map, Narsil, NarsilConfig,
    PartitionConfig, QueryParams, Storage, Value,
};
use support::ScratchDirectory;

const INDEX: &str = "orders";
const WORDS: [&str; 5] = ["amber", "basalt", "copper", "dune", "estuary"];
const DIMENSION: usize = 4;
const LOG_SEGMENT_DIGITS: usize = 16;
const DOCUMENTS_PER_PARTITION: u64 = 40;
const MAX_PARTITIONS: u64 = 16;
const SETTLE_LIMIT: Duration = Duration::from_secs(20);
const QUIET_INTERVALS: u32 = 8;

fn config(root: &Path, interval_ms: Option<u64>) -> NarsilConfig {
    NarsilConfig {
        durability: Some(DurabilityConfig {
            directory: Some(root.to_path_buf()),
            mode: Some(DurabilityMode::Sync),
            checkpoint_interval_ms: Some(interval_ms.unwrap_or(3_600_000)),
            checkpoint_mutation_threshold: Some(1_000_000),
            ..DurabilityConfig::default()
        }),
        ..NarsilConfig::default()
    }
}

fn index_config(storage: Storage, partitioned: bool) -> IndexConfig {
    let mut schema = Map::new();
    schema.insert("title", Value::String("string".into()));
    schema.insert("version", Value::String("number".into()));
    schema.insert("embedding", Value::String(format!("vector[{DIMENSION}]")));
    IndexConfig {
        schema: Value::Object(schema),
        text_storage: Some(storage),
        partitions: partitioned.then(|| PartitionConfig {
            max_docs_per_partition: Some(DOCUMENTS_PER_PARTITION),
            max_partitions: Some(MAX_PARTITIONS),
            ..PartitionConfig::default()
        }),
        ..IndexConfig::default()
    }
}

fn title_of(version: u64) -> String {
    let first = WORDS[(version % 5) as usize];
    let second = WORDS[((version / 5) % 5) as usize];
    format!("{first} {second} order {version} with a longer description of the goods")
}

fn document_of(version: u64) -> Map {
    let mut document = Map::new();
    document.insert("title", Value::String(title_of(version)));
    document.insert("version", Value::Number(version as f64));
    let embedding = (0..DIMENSION)
        .map(|at| {
            let value = ((version * 7 + at as u64 * 3) % 11) as f32 / 11.0;
            Value::Number(f64::from(value))
        })
        .collect();
    document.insert("embedding", Value::Array(embedding));
    document
}

fn files_under(directory: &Path, found: &mut Vec<(PathBuf, u64)>) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.is_dir() {
            files_under(&path, found);
        } else if !path.to_string_lossy().contains(".tmp-") {
            found.push((path, metadata.len()));
        }
    }
}

fn bytes_under(directory: &Path) -> u64 {
    let mut found = Vec::new();
    files_under(directory, &mut found);
    found.iter().map(|(_, bytes)| bytes).sum()
}

fn saved_on_disk(root: &Path) -> u64 {
    bytes_under(&root.join(INDEX).join("segments"))
}

fn partition_saved_on_disk(root: &Path, partition: usize) -> u64 {
    bytes_under(
        &root
            .join(INDEX)
            .join("segments")
            .join(partition.to_string()),
    )
}

fn is_log_segment(name: &str) -> bool {
    let digits = |text: &str| {
        text.len() == LOG_SEGMENT_DIGITS && text.bytes().all(|byte| byte.is_ascii_digit())
    };
    digits(name)
        || name
            .split_once('-')
            .is_some_and(|(start, moved)| digits(start) && digits(moved))
}

fn partition_log_on_disk(root: &Path, partition: usize) -> u64 {
    ["wal", "history"]
        .iter()
        .map(|kind| {
            let directory = root.join(INDEX).join(kind).join(partition.to_string());
            let Ok(entries) = std::fs::read_dir(directory) else {
                return 0;
            };
            entries
                .flatten()
                .filter(|entry| is_log_segment(&entry.file_name().to_string_lossy()))
                .filter_map(|entry| entry.metadata().ok())
                .map(|metadata| metadata.len())
                .sum::<u64>()
        })
        .sum()
}

fn log_on_disk(root: &Path, partitions: usize) -> u64 {
    (0..partitions)
        .map(|partition| partition_log_on_disk(root, partition))
        .sum()
}

fn segment_files(root: &Path) -> BTreeSet<PathBuf> {
    let mut found = Vec::new();
    files_under(&root.join(INDEX).join("segments"), &mut found);
    found.into_iter().map(|(path, _)| path).collect()
}

fn require_sizes_match_files(narsil: &Narsil, root: &Path, moment: &str) -> u64 {
    let stats = narsil.get_stats(INDEX).expect("the stats read");
    let saved = saved_on_disk(root);
    assert_eq!(stats.saved_bytes, Some(saved), "the saved size {moment}");
    assert_eq!(
        stats.log_bytes,
        Some(log_on_disk(root, stats.partition_count)),
        "the log size {moment}"
    );
    let partitions = narsil
        .get_partition_stats(INDEX)
        .expect("the partition stats read");
    for partition in &partitions {
        let id = partition.partition_id;
        assert_eq!(
            partition.saved_bytes,
            Some(partition_saved_on_disk(root, id)),
            "the saved size of partition {id} {moment}"
        );
        assert_eq!(
            partition.log_bytes,
            Some(partition_log_on_disk(root, id)),
            "the log size of partition {id} {moment}"
        );
    }
    saved
}

fn put(narsil: &Narsil, model: &mut BTreeMap<String, u64>, id: &str, version: u64) {
    if model.contains_key(id) {
        narsil
            .update(INDEX, id, document_of(version))
            .expect("the update applies");
    } else {
        narsil
            .insert(INDEX, document_of(version), Some(id))
            .expect("the insert applies");
    }
    model.insert(id.to_string(), version);
}

fn remove(narsil: &Narsil, model: &mut BTreeMap<String, u64>, id: &str) {
    narsil.remove(INDEX, id).expect("the removal applies");
    model.remove(id);
}

fn require_documents(narsil: &Narsil, model: &BTreeMap<String, u64>, moment: &str) {
    assert_eq!(
        narsil.count_documents(INDEX).expect("the count reads"),
        model.len() as u64,
        "the count {moment}"
    );
    for word in WORDS {
        let query = QueryParams {
            term: Some(word.to_string()),
            limit: Some(10_000),
            ..QueryParams::default()
        };
        let found = narsil.query(INDEX, &query).expect("the search answers");
        let ids: BTreeSet<String> = found.hits.into_iter().map(|hit| hit.id).collect();
        let wanted: BTreeSet<String> = model
            .iter()
            .filter(|(_, version)| title_of(**version).split(' ').any(|token| token == word))
            .map(|(id, _)| id.clone())
            .collect();
        assert_eq!(ids, wanted, "the search for {word} {moment}");
    }
    let ids: Vec<String> = model.keys().cloned().collect();
    for (id, document) in narsil
        .get_multiple(INDEX, &ids)
        .expect("the documents read")
    {
        let version = model.get(&id).copied().expect("only held documents return");
        assert_eq!(document, document_of(version), "{id} {moment}");
    }
}

fn restore_keeps_sizes_matching_files(
    narsil: &Narsil,
    root: &Path,
    mut model: BTreeMap<String, u64>,
) {
    let mut archive = Vec::new();
    narsil
        .snapshot(INDEX, &mut archive)
        .expect("the snapshot writes");
    let archived = model.clone();
    for at in 0..10 {
        put(
            narsil,
            &mut model,
            &format!("after-archive-{at}"),
            3_000 + at,
        );
    }
    narsil.checkpoint(INDEX).expect("the checkpoint commits");
    let truncated = &archive[..archive.len() / 2];
    assert!(
        narsil.restore(INDEX, &mut &truncated[..]).is_err(),
        "a truncated archive is refused"
    );
    require_sizes_match_files(narsil, root, "after a refused restore");
    require_documents(narsil, &model, "after a refused restore");
    narsil
        .restore(INDEX, &mut archive.as_slice())
        .expect("the restore applies");
    require_sizes_match_files(narsil, root, "after a restore");
    require_documents(narsil, &archived, "after a restore");
}

fn sizes_match_the_files(storage: Storage) {
    let root = ScratchDirectory::new("saved-size");
    let narsil = Narsil::open(config(root.path(), None)).expect("the engine opens");
    narsil
        .create_index(INDEX, index_config(storage, true))
        .expect("the index is created");
    let mut model = BTreeMap::new();
    for at in 0..150 {
        put(&narsil, &mut model, &format!("order-{at}"), at);
    }
    for at in 0..20 {
        put(
            &narsil,
            &mut model,
            &format!("order-{}", at * 3),
            1_000 + at,
        );
    }
    for at in 0..30 {
        remove(&narsil, &mut model, &format!("order-{}", at * 5 + 1));
    }
    let stats = narsil.get_stats(INDEX).expect("the stats read");
    assert!(
        stats.partition_count > 1,
        "the index spreads over partitions"
    );
    require_sizes_match_files(&narsil, root.path(), "before any checkpoint");
    narsil.checkpoint(INDEX).expect("the checkpoint commits");
    let saved = require_sizes_match_files(&narsil, root.path(), "after a checkpoint");
    assert!(saved > 0, "the checkpoint saves files");
    for at in 0..5 {
        put(&narsil, &mut model, &format!("late-{at}"), 2_000 + at);
    }
    let after_writes =
        require_sizes_match_files(&narsil, root.path(), "after writes past the checkpoint");
    assert_eq!(after_writes, saved, "writes alone leave the saved size");
    narsil.shutdown().expect("the engine shuts down");

    let starts_closed = NarsilConfig {
        lifecycle: Some(IndexLifecycleConfig::default()),
        ..config(root.path(), None)
    };
    let narsil = Narsil::open(starts_closed).expect("the engine opens with closed indexes");
    let closed = narsil.get_stats(INDEX).expect("the closed stats read");
    assert_eq!(
        closed.saved_bytes,
        Some(saved),
        "the metadata records the saved size"
    );
    assert_eq!(closed.log_bytes, None, "a closed index reports no log size");
    narsil.shutdown().expect("the engine shuts down");

    let narsil = Narsil::open(config(root.path(), None)).expect("the engine reopens");
    let reopened = require_sizes_match_files(&narsil, root.path(), "after a restart");
    assert_eq!(reopened, saved, "a restart keeps the saved size");
    require_documents(&narsil, &model, "after a restart");
    narsil.close_index(INDEX).expect("the index closes");
    let closed = narsil.get_stats(INDEX).expect("the closed stats read");
    assert_eq!(closed.saved_bytes, Some(saved_on_disk(root.path())));
    assert_eq!(closed.log_bytes, None, "a closed index reports no log size");
    narsil.open_index(INDEX).expect("the index opens again");
    require_sizes_match_files(&narsil, root.path(), "after the index opens again");
    if storage == Storage::Memory {
        restore_keeps_sizes_matching_files(&narsil, root.path(), model);
    }
    narsil.drop_index(INDEX).expect("the index drops");
    narsil
        .create_index(INDEX, index_config(storage, true))
        .expect("the name takes a new index");
    let fresh = narsil.get_stats(INDEX).expect("the new stats read");
    assert_eq!(fresh.saved_bytes, Some(0), "a new index saves nothing yet");
    assert_eq!(
        fresh.log_bytes,
        Some(log_on_disk(root.path(), fresh.partition_count))
    );
    narsil.shutdown().expect("the engine shuts down");
}

#[test]
fn sizes_equal_the_files_on_disk_through_a_restart_and_a_close() {
    sizes_match_the_files(Storage::Memory);
}

#[test]
fn sizes_equal_the_files_on_disk_for_text_on_disk() {
    sizes_match_the_files(Storage::Disk);
}

#[test]
fn an_engine_without_durability_reports_no_size() {
    let narsil = Narsil::new();
    narsil
        .create_index(INDEX, index_config(Storage::Memory, false))
        .expect("the index is created");
    narsil
        .insert(INDEX, document_of(1), Some("order-1"))
        .expect("the insert applies");
    let stats = narsil.get_stats(INDEX).expect("the stats read");
    assert_eq!((stats.saved_bytes, stats.log_bytes), (None, None));
    let partitions = narsil
        .get_partition_stats(INDEX)
        .expect("the partition stats read");
    assert!(
        partitions
            .iter()
            .all(|partition| partition.saved_bytes.is_none() && partition.log_bytes.is_none())
    );
}

fn wait_until_quiet(root: &Path, interval: Duration) -> BTreeSet<PathBuf> {
    let mut files = segment_files(root);
    let mut quiet = 0;
    while quiet < QUIET_INTERVALS {
        std::thread::sleep(interval);
        let now = segment_files(root);
        quiet = if now == files { quiet + 1 } else { 0 };
        files = now;
    }
    files
}

fn removals_free_space_without_a_write(storage: Storage) {
    let root = ScratchDirectory::new("removed-share");
    let narsil = Narsil::open(config(root.path(), None)).expect("the engine opens");
    narsil
        .create_index(INDEX, index_config(storage, false))
        .expect("the index is created");
    let mut model = BTreeMap::new();
    for at in 0..300 {
        put(&narsil, &mut model, &format!("order-{at}"), at);
    }
    narsil
        .checkpoint(INDEX)
        .expect("the first checkpoint commits");
    let full = saved_on_disk(root.path());
    for at in 0..300 {
        if at % 2 == 0 {
            remove(&narsil, &mut model, &format!("order-{at}"));
        }
    }
    narsil.shutdown().expect("the engine shuts down");
    assert_eq!(
        saved_on_disk(root.path()),
        full,
        "the removals stay in the log"
    );

    let interval_ms = 40;
    let narsil = Narsil::open(config(root.path(), Some(interval_ms))).expect("the engine reopens");
    let started = Instant::now();
    while saved_on_disk(root.path()) * 10 > full * 7 {
        assert!(
            started.elapsed() < SETTLE_LIMIT,
            "the saved size stays at {} of {full} bytes with half the documents removed",
            saved_on_disk(root.path())
        );
        std::thread::sleep(Duration::from_millis(interval_ms));
    }
    let settled = wait_until_quiet(root.path(), Duration::from_millis(interval_ms));
    assert!(!settled.is_empty(), "the checkpoint keeps its files");
    let saved = require_sizes_match_files(&narsil, root.path(), "after the rewrite");
    assert!(saved * 10 <= full * 7, "{saved} of {full} bytes remain");
    require_documents(&narsil, &model, "after the rewrite");
    narsil.shutdown().expect("the engine shuts down");

    let narsil = Narsil::open(config(root.path(), None)).expect("the engine reopens");
    require_documents(&narsil, &model, "after a restart that follows the rewrite");
    assert_eq!(
        narsil.get_stats(INDEX).expect("the stats read").saved_bytes,
        Some(saved)
    );
    narsil.shutdown().expect("the engine shuts down");
}

#[test]
fn removals_past_a_fifth_free_their_space_with_no_further_write() {
    removals_free_space_without_a_write(Storage::Memory);
}

#[test]
fn removals_past_a_fifth_free_their_space_for_text_on_disk() {
    removals_free_space_without_a_write(Storage::Disk);
}

#[test]
fn an_index_without_removals_writes_no_file_at_an_idle_interval() {
    let root = ScratchDirectory::new("idle-interval");
    let interval_ms = 30;
    let narsil = Narsil::open(config(root.path(), Some(interval_ms))).expect("the engine opens");
    narsil
        .create_index(INDEX, index_config(Storage::Memory, false))
        .expect("the index is created");
    let mut model = BTreeMap::new();
    for at in 0..120 {
        put(&narsil, &mut model, &format!("order-{at}"), at);
    }
    narsil.checkpoint(INDEX).expect("the checkpoint commits");
    let files = wait_until_quiet(root.path(), Duration::from_millis(interval_ms));
    std::thread::sleep(Duration::from_millis(interval_ms * 6));
    assert_eq!(
        segment_files(root.path()),
        files,
        "an idle index rewrites nothing"
    );
    require_sizes_match_files(&narsil, root.path(), "at an idle interval");
    narsil.shutdown().expect("the engine shuts down");
}
