#![cfg(target_os = "linux")]

mod support;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use narsil::{
    AdapterSetting, DurabilityConfig, EmbeddingConfig, ErrorCode, HnswSettings, IndexConfig, Map,
    MemoryConfig, Narsil, NarsilConfig, QueryParams, Storage, Value, VectorPromotion, VectorQuery,
    parse_json,
};
use support::adapters::EmbedWith;

const MAPPED_INDEX: &str = "passages";
const WRITTEN_INDEX: &str = "ledger";
const FIELD: &str = "embedding";
const DOCUMENTS: u64 = 8_192;
const DIMENSION: usize = 4_096;
const FLOAT32_BYTES: u64 = 4;
const MAPPED_VECTOR_BYTES: u64 = DOCUMENTS * DIMENSION as u64 * FLOAT32_BYTES;
const BUILD_BATCH_DOCUMENTS: u64 = 512;
const GRAPH_THRESHOLD: u64 = 64;
const MEBIBYTE_BYTES: u64 = 1024 * 1024;
const KIBIBYTE_BYTES: u64 = 1024;
const ANONYMOUS_MARGIN_BYTES: u64 = 48 * MEBIBYTE_BYTES;
const ANONYMOUS_GROWTH_MARGINS: u64 = 3;
const WRITES_BESIDE_MAPPED_VECTORS: u64 = 3;
const LOAD_WAIT: Duration = Duration::from_secs(120);
const LOAD_POLL: Duration = Duration::from_millis(50);
const STALE_MEASUREMENT_WAIT: Duration = Duration::from_millis(50);
const TMPFS_TYPES: [&str; 2] = ["tmpfs", "ramfs"];
const DISK_TEMPORARY_DIRECTORY: &str = "/var/tmp";
const CGROUP_ROOT: &str = "/sys/fs/cgroup";
const CGROUP_V2_LIMIT_FILES: [&str; 2] = ["memory.max", "memory.high"];
const CGROUP_V1_MEMORY_ROOT: &str = "/sys/fs/cgroup/memory";
const CGROUP_V1_LIMIT_FILES: [&str; 1] = ["memory.limit_in_bytes"];

struct DiskDirectory {
    path: PathBuf,
}

impl Drop for DiskDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn file_system_type_of(path: &Path) -> String {
    let mounts = std::fs::read_to_string("/proc/self/mounts").expect("the kernel lists mounts");
    let mut best: Option<(usize, String)> = None;
    for line in mounts.lines() {
        let mut fields = line.split_whitespace();
        let (Some(_), Some(point), Some(kind)) = (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let point = point.replace("\\040", " ");
        if path.starts_with(&point)
            && best
                .as_ref()
                .is_none_or(|(length, _)| point.len() >= *length)
        {
            best = Some((point.len(), kind.to_string()));
        }
    }
    best.map(|(_, kind)| kind).unwrap_or_default()
}

fn disk_directory() -> DiskDirectory {
    let candidates = [
        std::env::temp_dir(),
        PathBuf::from(DISK_TEMPORARY_DIRECTORY),
    ];
    let parent = candidates
        .iter()
        .find(|candidate| !TMPFS_TYPES.contains(&file_system_type_of(candidate).as_str()))
        .expect("a temporary directory lies on a disk, so a file can back the vectors");
    let path = parent.join(format!("narsil-file-backed-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).expect("the directory is made");
    DiskDirectory { path }
}

fn kibibyte_field(text: &str, field: &str) -> u64 {
    let line = text
        .lines()
        .find_map(|line| line.strip_prefix(field))
        .unwrap_or_else(|| panic!("the kernel reports {field}"));
    let kibibytes: u64 = line
        .trim()
        .trim_end_matches("kB")
        .trim()
        .parse()
        .expect("the figure is a number");
    kibibytes * KIBIBYTE_BYTES
}

struct ProcessStatus {
    unbacked_bytes: u64,
    file_bytes: u64,
}

fn process_status() -> ProcessStatus {
    let status = std::fs::read_to_string("/proc/self/status").expect("the kernel reports status");
    ProcessStatus {
        unbacked_bytes: kibibyte_field(&status, "RssAnon:") + kibibyte_field(&status, "RssShmem:"),
        file_bytes: kibibyte_field(&status, "RssFile:"),
    }
}

#[cfg(target_env = "gnu")]
unsafe extern "C" {
    fn malloc_trim(pad: usize) -> i32;
}

fn release_free_pages() {
    #[cfg(target_env = "gnu")]
    unsafe {
        malloc_trim(0);
    }
}

fn settled_process_status() -> ProcessStatus {
    release_free_pages();
    process_status()
}

fn smallest_limit_above(root: &Path, member: &str, files: &[&str]) -> Option<u64> {
    let mut directory = root.join(member.trim_start_matches('/'));
    let mut smallest: Option<u64> = None;
    loop {
        for file in files {
            let limit = std::fs::read_to_string(directory.join(file))
                .ok()
                .and_then(|text| text.trim().parse::<u64>().ok());
            smallest = match (smallest, limit) {
                (Some(held), Some(found)) => Some(held.min(found)),
                (held, found) => held.or(found),
            };
        }
        if directory == root || !directory.pop() {
            return smallest;
        }
    }
}

fn container_limit_bytes() -> Option<u64> {
    let membership = std::fs::read_to_string("/proc/self/cgroup").ok()?;
    membership
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, ':');
            let (_, controllers, member) = (parts.next()?, parts.next()?, parts.next()?);
            if controllers.is_empty() {
                smallest_limit_above(Path::new(CGROUP_ROOT), member, &CGROUP_V2_LIMIT_FILES)
            } else if controllers.split(',').any(|name| name == "memory") {
                smallest_limit_above(
                    Path::new(CGROUP_V1_MEMORY_ROOT),
                    member,
                    &CGROUP_V1_LIMIT_FILES,
                )
            } else {
                None
            }
        })
        .min()
}

fn process_limit_bytes(unbacked_bytes: u64) -> u64 {
    let meminfo = std::fs::read_to_string("/proc/meminfo").expect("the kernel reports memory");
    let host = kibibyte_field(&meminfo, "MemTotal:");
    match container_limit_bytes() {
        Some(container) if container < host => container,
        _ => host.min(unbacked_bytes + kibibyte_field(&meminfo, "MemAvailable:")),
    }
}

fn unbacked_fraction(status: &ProcessStatus) -> f64 {
    status.unbacked_bytes as f64 / process_limit_bytes(status.unbacked_bytes) as f64
}

fn block_level_one_margin_above(before: &ProcessStatus) -> f64 {
    (before.unbacked_bytes + ANONYMOUS_MARGIN_BYTES) as f64
        / process_limit_bytes(before.unbacked_bytes) as f64
}

fn vector_of(serial: u64) -> Vec<f64> {
    let mut state = serial.wrapping_mul(0x9E37_79B9_7F4A_7C15).wrapping_add(1);
    (0..DIMENSION)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state % 2_000_001) as f64 / 1_000_000.0 - 1.0
        })
        .collect()
}

fn passage(serial: u64) -> Map {
    let mut map = Map::new();
    map.insert("id", Value::String(format!("passage-{serial}")));
    map.insert("serial", Value::Number(serial as f64));
    map.insert(
        FIELD,
        Value::Array(vector_of(serial).into_iter().map(Value::Number).collect()),
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

fn mapped_index() -> IndexConfig {
    IndexConfig {
        schema: parse_json(&format!(
            r#"{{"serial": "number", "{FIELD}": "vector[{DIMENSION}]"}}"#
        ))
        .expect("the schema is JSON"),
        vector_promotion: Some(VectorPromotion {
            threshold: Some(GRAPH_THRESHOLD),
            filter_threshold: Some(1.0),
            storage: Some(Storage::Disk),
            hnsw: Some(HnswSettings {
                m: Some(4),
                ef_construction: Some(8),
                ..HnswSettings::default()
            }),
            ..VectorPromotion::default()
        }),
        ..IndexConfig::default()
    }
}

fn vector_query(serial: u64, filters: Option<Value>) -> QueryParams {
    QueryParams {
        vector: Some(VectorQuery {
            field: FIELD.to_string(),
            value: Some(
                vector_of(serial)
                    .into_iter()
                    .map(|component| component as f32)
                    .collect(),
            ),
            ..VectorQuery::default()
        }),
        filters,
        limit: Some(1),
        ..QueryParams::default()
    }
}

fn build(root: &Path) {
    let engine = Narsil::open(durable(root)).expect("the engine opens");
    engine
        .create_index(MAPPED_INDEX, mapped_index())
        .expect("the index is made");
    let mut first = 0;
    while first < DOCUMENTS {
        let last = (first + BUILD_BATCH_DOCUMENTS).min(DOCUMENTS);
        let inserted = engine
            .insert_batch(MAPPED_INDEX, (first..last).map(passage).collect())
            .expect("the batch is stored");
        assert!(inserted.failed.is_empty(), "every passage is stored");
        first = last;
    }
    engine
        .checkpoint(MAPPED_INDEX)
        .expect("the checkpoint is written");
    engine.shutdown().expect("the engine shuts down");
}

fn wait_for_vector_files(engine: &Narsil) {
    let deadline = Instant::now() + LOAD_WAIT;
    loop {
        assert!(
            Instant::now() < deadline,
            "the vector field finishes loading from its files"
        );
        engine
            .query(MAPPED_INDEX, &vector_query(0, None))
            .expect("the vector search answers");
        std::thread::sleep(LOAD_POLL);
        let loading = engine
            .vector_maintenance_status(MAPPED_INDEX)
            .expect("the field reports its maintenance")
            .iter()
            .any(|field| field.loading_from_files);
        if !loading {
            break;
        }
    }
}

fn fault_every_mapped_page(engine: &Narsil) -> Option<String> {
    let filters = parse_json(r#"{"fields": {"serial": {"gte": 1}}}"#).expect("the filter is JSON");
    let found = engine
        .query(MAPPED_INDEX, &vector_query(DOCUMENTS - 1, Some(filters)))
        .expect("the filtered vector search answers");
    found.hits.first().map(|hit| hit.id.clone())
}

fn ledger_entry(serial: u64) -> Map {
    let mut map = Map::new();
    map.insert("body", Value::String(format!("ledger entry {serial}")));
    map
}

#[test]
fn writes_beside_vector_files_mapped_from_disk_pass_until_anonymous_memory_passes_the_block_level()
{
    let directory = disk_directory();
    build(&directory.path);

    let mapped = Narsil::open(durable(&directory.path)).expect("the engine reopens");
    wait_for_vector_files(&mapped);
    let nearest = fault_every_mapped_page(&mapped);
    assert_eq!(
        nearest.as_deref(),
        Some(format!("passage-{}", DOCUMENTS - 1).as_str())
    );
    let before = settled_process_status();
    assert!(
        before.file_bytes > MAPPED_VECTOR_BYTES,
        "the vector file is resident through its mapping: {} bytes",
        before.file_bytes
    );

    let block_writes_above = block_level_one_margin_above(&before);
    let written = Narsil::open(NarsilConfig {
        memory: Some(MemoryConfig {
            block_writes_above: Some(block_writes_above),
            resume_writes_below: Some(block_writes_above / 2.0),
        }),
        ..NarsilConfig::default()
    })
    .expect("the second engine opens");
    written
        .create_index(
            WRITTEN_INDEX,
            IndexConfig {
                schema: parse_json(r#"{"body": "string"}"#).expect("the schema is JSON"),
                ..IndexConfig::default()
            },
        )
        .expect("the ledger is made");
    for serial in 1..=WRITES_BESIDE_MAPPED_VECTORS {
        fault_every_mapped_page(&mapped);
        std::thread::sleep(STALE_MEASUREMENT_WAIT);
        let fraction = unbacked_fraction(&settled_process_status());
        assert!(
            fraction <= block_writes_above,
            "the unbacked memory stays at or below the block level: {fraction} of the limit against {block_writes_above}"
        );
        written
            .insert(WRITTEN_INDEX, ledger_entry(serial), None)
            .expect("a write beside the mapped vectors is accepted");
    }

    let last_write = Instant::now();
    let grown = vec![1_u8; (ANONYMOUS_GROWTH_MARGINS * ANONYMOUS_MARGIN_BYTES) as usize];
    std::thread::sleep(STALE_MEASUREMENT_WAIT);
    let after = settled_process_status();
    assert!(
        after.unbacked_bytes > before.unbacked_bytes + ANONYMOUS_MARGIN_BYTES,
        "the anonymous memory grows past the block level: {} bytes before, {} after",
        before.unbacked_bytes,
        after.unbacked_bytes
    );
    let fraction = unbacked_fraction(&after);
    assert!(
        fraction > block_writes_above,
        "the unbacked memory passes the block level: {fraction} of the limit against {block_writes_above}"
    );
    assert!(last_write.elapsed() < Duration::from_secs(1));
    let refused = written
        .insert(
            WRITTEN_INDEX,
            ledger_entry(WRITES_BESIDE_MAPPED_VECTORS + 1),
            None,
        )
        .expect_err("a write once anonymous memory passes the block level is refused");
    assert_eq!(refused.code(), ErrorCode::MEMORY_WRITE_BLOCKED);
    assert_eq!(
        grown.iter().map(|byte| u64::from(*byte)).sum::<u64>(),
        grown.len() as u64
    );
    drop(grown);
    written.shutdown().unwrap();
    for operation in ["insert", "update", "insert_batch", "update_batch"] {
        refuse_after_embedding(operation);
    }
}

fn refuse_after_embedding(operation: &str) {
    let block = block_level_one_margin_above(&settled_process_status());
    let engine = Arc::new(
        Narsil::open(NarsilConfig {
            memory: Some(MemoryConfig {
                block_writes_above: Some(block),
                resume_writes_below: Some(block / 2.0),
            }),
            ..NarsilConfig::default()
        })
        .unwrap(),
    );
    engine
        .create_index(
            WRITTEN_INDEX,
            IndexConfig {
                schema: parse_json(r#"{"body":"string"}"#).unwrap(),
                ..IndexConfig::default()
            },
        )
        .unwrap();
    let target = Arc::downgrade(&engine);
    let held = Arc::new(Mutex::new(Vec::new()));
    let ballast = Arc::clone(&held);
    let measured = Arc::new(Mutex::new(None));
    let measurement = Arc::clone(&measured);
    engine
        .register_embedding_adapter(
            "pressure",
            Arc::new(EmbedWith {
                dimensions: 2,
                embed: move |_: &str| {
                    let engine = target.upgrade().unwrap();
                    engine
                        .insert(WRITTEN_INDEX, ledger_entry(0), Some("nested"))
                        .unwrap();
                    *ballast.lock().unwrap() =
                        vec![1_u8; (ANONYMOUS_GROWTH_MARGINS * ANONYMOUS_MARGIN_BYTES) as usize];
                    std::thread::sleep(STALE_MEASUREMENT_WAIT);
                    *measurement.lock().unwrap() =
                        Some(unbacked_fraction(&settled_process_status()));
                    let error = engine
                        .insert(WRITTEN_INDEX, ledger_entry(1), Some("refused"))
                        .unwrap_err();
                    assert_eq!(error.code(), ErrorCode::MEMORY_WRITE_BLOCKED);
                    Ok(vec![1.0, 0.0])
                },
            }),
        )
        .unwrap();
    engine
        .create_index(
            "embedded",
            IndexConfig {
                schema: parse_json(r#"{"body":"string","embedding":"vector[2]"}"#).unwrap(),
                embedding: Some(EmbeddingConfig {
                    fields: vec![("embedding".into(), vec!["body".into()])],
                    adapter: Some(AdapterSetting::Named("pressure".into())),
                }),
                ..IndexConfig::default()
            },
        )
        .unwrap();
    let mut original = ledger_entry(0);
    original.insert(
        "embedding",
        Value::Array(vec![Value::Number(0.0), Value::Number(1.0)]),
    );
    engine
        .insert("embedded", original.clone(), Some("original"))
        .unwrap();
    let failure = match operation {
        "insert" => engine
            .insert("embedded", ledger_entry(1), Some("outer"))
            .unwrap_err(),
        "update" => engine
            .update("embedded", "original", ledger_entry(1))
            .unwrap_err(),
        "insert_batch" => {
            engine
                .insert_batch("embedded", vec![ledger_entry(1)])
                .unwrap()
                .failed
                .remove(0)
                .error
        }
        _ => {
            engine
                .update_batch("embedded", vec![("original".into(), ledger_entry(1))])
                .unwrap()
                .failed
                .remove(0)
                .error
        }
    };
    let fraction = measured
        .lock()
        .unwrap()
        .expect("the adapter measures the memory");
    assert!(
        fraction > block,
        "the unbacked memory passes the block level inside {operation}: {fraction} of the limit against {block}"
    );
    assert_eq!(
        failure.code(),
        ErrorCode::MEMORY_WRITE_BLOCKED,
        "{operation}"
    );
    assert_eq!(engine.count_documents("embedded").unwrap(), 1);
    assert_eq!(engine.get("embedded", "original").unwrap(), Some(original));
    assert!(engine.get(WRITTEN_INDEX, "nested").unwrap().is_some());
    assert!(engine.get(WRITTEN_INDEX, "refused").unwrap().is_none());
    assert!(!held.lock().unwrap().is_empty());
    engine.shutdown().unwrap();
}
