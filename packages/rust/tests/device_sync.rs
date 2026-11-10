mod support;

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Cursor, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use narsil::{
    DurabilityConfig, DurabilityTier, IndexConfig, Map, MemoryPersistence, Narsil, NarsilConfig,
    PartitionConfig, SyncSetting, SyncStatus, Value, parse_json, write_json,
};
use support::{ScratchDirectory, repository_root};

const INDEX: &str = "notes";
const CHILD_DIRECTORY: &str = "NARSIL_SYNC_CRASH_DIRECTORY";
const SAFE_INTEGER_LIMIT: u64 = 9_007_199_254_740_991;
const RETENTION_WAIT: Duration = Duration::from_secs(60);
const CRASH_ACKNOWLEDGEMENTS: usize = 400;

fn log_config(root: &Path) -> NarsilConfig {
    NarsilConfig {
        durability: Some(DurabilityConfig {
            directory: Some(root.to_path_buf()),
            ..DurabilityConfig::default()
        }),
        ..NarsilConfig::default()
    }
}

fn note_of(id: &str) -> Map {
    let mut note = Map::new();
    note.insert("title", Value::String(format!("note {id}")));
    note.insert(
        "body",
        Value::String(format!("written by the reference as {id}")),
    );
    note
}

fn rust_note_of(id: &str) -> Map {
    let mut note = Map::new();
    note.insert("title", Value::String(format!("rust note {id}")));
    note.insert(
        "body",
        Value::String(format!("written by the crate as {id}")),
    );
    note
}

fn index_config() -> IndexConfig {
    let mut schema = Map::new();
    schema.insert("title", Value::String("string".into()));
    schema.insert("body", Value::String("string".into()));
    IndexConfig {
        schema: Value::Object(schema),
        ..IndexConfig::default()
    }
}

fn ids(prefix: &str, count: usize) -> Vec<String> {
    (0..count).map(|at| format!("{prefix}{at}")).collect()
}

fn texts(list: &[String]) -> Value {
    Value::Array(list.iter().cloned().map(Value::String).collect())
}

fn reference(spec: Map, scratch: &Path) -> Map {
    let spec_path = scratch.join("sync-spec.json");
    std::fs::write(&spec_path, write_json(&Value::Object(spec))).expect("the spec is written");
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/reference_sync.mjs");
    let output = Command::new("node")
        .arg(script)
        .arg(repository_root())
        .arg(&spec_path)
        .output()
        .expect("node runs the TypeScript reference");
    assert!(
        output.status.success(),
        "the TypeScript reference failed; build packages/ts first: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout).expect("the reference writes UTF-8");
    match parse_json(&text).expect("the reference writes JSON") {
        Value::Object(outcome) => outcome,
        _ => panic!("the reference wrote no object"),
    }
}

struct Synced {
    scratch: ScratchDirectory,
    root: PathBuf,
    first: Vec<String>,
    later: Vec<String>,
    epoch: String,
}

fn synced_by_reference(label: &str) -> Synced {
    let scratch = ScratchDirectory::new(label);
    let root = scratch.path().join("data");
    let first = ids("n", 300);
    let later = ids("l", 120);
    let mut spec = Map::new();
    spec.insert("action", Value::String("activate".into()));
    spec.insert(
        "directory",
        Value::String(root.to_string_lossy().into_owned()),
    );
    spec.insert("first", texts(&first));
    spec.insert("later", texts(&later));
    let outcome = reference(spec, scratch.path());
    let status = status_from(outcome.get("status"));
    assert!(
        status.enabled && status.active,
        "the reference activates sync: {status:?}"
    );
    let epoch = status.epoch.expect("an active index has an epoch");
    Synced {
        scratch,
        root,
        first,
        later,
        epoch,
    }
}

fn number(value: Option<&Value>) -> Option<u64> {
    match value {
        Some(Value::Number(number)) => Some(*number as u64),
        _ => None,
    }
}

fn status_from(value: Option<&Value>) -> SyncStatus {
    let Some(Value::Object(map)) = value else {
        panic!("the reference wrote no sync status");
    };
    SyncStatus {
        enabled: matches!(map.get("enabled"), Some(Value::Bool(true))),
        history_max_age_ms: number(map.get("historyMaxAgeMs")),
        history_max_bytes: number(map.get("historyMaxBytes")),
        active: matches!(map.get("active"), Some(Value::Bool(true))),
        epoch: match map.get("epoch") {
            Some(Value::String(epoch)) => Some(epoch.clone()),
            _ => None,
        },
    }
}

struct Inspected {
    status: SyncStatus,
    count: u64,
    held: BTreeMap<String, Map>,
    snapshot_status: Option<u64>,
}

fn inspected_by_reference(synced: &Synced, wanted: &[String]) -> Inspected {
    let mut spec = Map::new();
    spec.insert("action", Value::String("inspect".into()));
    spec.insert(
        "directory",
        Value::String(synced.root.to_string_lossy().into_owned()),
    );
    spec.insert("ids", texts(wanted));
    let outcome = reference(spec, synced.scratch.path());
    let mut held = BTreeMap::new();
    if let Some(Value::Array(rows)) = outcome.get("held") {
        for row in rows {
            let Value::Object(row) = row else { continue };
            let (Some(Value::String(id)), Some(Value::Object(document))) =
                (row.get("id"), row.get("document"))
            else {
                continue;
            };
            held.insert(id.clone(), document.clone());
        }
    }
    let snapshot_status = match outcome.get("snapshot") {
        Some(Value::Object(snapshot)) => number(snapshot.get("status")),
        _ => None,
    };
    Inspected {
        status: status_from(outcome.get("status")),
        count: number(outcome.get("count")).unwrap_or(u64::MAX),
        held,
        snapshot_status,
    }
}

fn files_under(directory: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut pending = vec![directory.to_path_buf()];
    while let Some(next) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&next) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else {
                found.push(path);
            }
        }
    }
    found.sort();
    found
}

fn history_files(root: &Path) -> Vec<PathBuf> {
    files_under(&root.join(INDEX).join("history"))
}

fn published_file(root: &Path) -> PathBuf {
    root.join(INDEX).join("sync").join("published")
}

fn require_documents(narsil: &Narsil, oracle: &BTreeMap<String, Map>) {
    assert_eq!(
        narsil.count_documents(INDEX).expect("the count answers"),
        oracle.len() as u64,
        "the index holds every document of the oracle and no other"
    );
    for (id, wanted) in oracle {
        let held = narsil.get(INDEX, id).expect("the read answers");
        assert_eq!(held.as_ref(), Some(wanted), "document {id}");
    }
}

fn oracle_of(synced: &Synced, written: &[String]) -> BTreeMap<String, Map> {
    let mut oracle: BTreeMap<String, Map> = synced
        .later
        .iter()
        .map(|id| (id.clone(), note_of(id)))
        .collect();
    for id in &synced.first {
        let mut note = Map::new();
        note.insert("id", Value::String(id.clone()));
        for (field, value) in note_of(id).iter() {
            note.insert(field.as_str(), value.clone());
        }
        oracle.insert(id.clone(), note);
    }
    for id in written {
        oracle.insert(id.clone(), rust_note_of(id));
    }
    oracle
}

fn require_reference_reads(synced: &Synced, oracle: &BTreeMap<String, Map>, wanted: &SyncStatus) {
    let wanted_ids: Vec<String> = oracle.keys().cloned().collect();
    let inspected = inspected_by_reference(synced, &wanted_ids);
    assert_eq!(
        &inspected.status, wanted,
        "the reference reads the sync state"
    );
    assert_eq!(
        inspected.count,
        oracle.len() as u64,
        "the reference counts every document"
    );
    assert_eq!(
        &inspected.held, oracle,
        "the reference reads every document whole"
    );
    if wanted.enabled {
        assert_eq!(
            inspected.snapshot_status,
            Some(200),
            "the reference serves the snapshot"
        );
    }
}

fn error_code<T: std::fmt::Debug>(outcome: narsil::Result<T>) -> String {
    outcome
        .expect_err("the call fails")
        .code()
        .as_str()
        .to_string()
}

#[test]
fn sync_needs_the_log_tier_a_known_index_and_whole_limits() {
    let memory = Narsil::open(NarsilConfig::default()).expect("the memory engine opens");
    memory
        .create_index(INDEX, index_config())
        .expect("the index is made");
    let on = SyncSetting {
        enabled: true,
        ..SyncSetting::default()
    };
    assert_eq!(
        error_code(memory.update_sync(INDEX, &on)),
        "SYNC_DURABILITY_REQUIRED"
    );
    let snapshot_tier = Narsil::open(NarsilConfig {
        durability: Some(DurabilityConfig {
            tier: Some(DurabilityTier::Snapshot),
            ..DurabilityConfig::default()
        }),
        persistence: Some(Arc::new(MemoryPersistence::new())),
        ..NarsilConfig::default()
    })
    .expect("the snapshot tier opens");
    snapshot_tier
        .create_index(INDEX, index_config())
        .expect("the index is made");
    assert_eq!(
        error_code(snapshot_tier.update_sync(INDEX, &on)),
        "SYNC_DURABILITY_REQUIRED"
    );
    let scratch = ScratchDirectory::new("sync-refusals");
    let narsil = Narsil::open(log_config(scratch.path())).expect("the log tier opens");
    narsil
        .create_index(INDEX, index_config())
        .expect("the index is made");
    assert_eq!(
        error_code(narsil.update_sync("missing", &on)),
        "INDEX_NOT_FOUND"
    );
    assert_eq!(error_code(narsil.get_sync("missing")), "INDEX_NOT_FOUND");
    let refused = [
        (Some(0), None),
        (None, Some(0)),
        (Some(SAFE_INTEGER_LIMIT + 1), None),
        (None, Some(u64::MAX)),
    ];
    for (age, bytes) in refused {
        let setting = SyncSetting {
            enabled: true,
            history_max_age_ms: age,
            history_max_bytes: bytes,
        };
        assert_eq!(
            error_code(narsil.update_sync(INDEX, &setting)),
            "CONFIG_INVALID"
        );
    }
    assert_eq!(
        narsil.get_sync(INDEX).expect("the state reads"),
        SyncStatus::default()
    );
    narsil.shutdown().expect("the engine shuts down");
}

fn epoch_of(narsil: &Narsil) -> String {
    let status = narsil.get_sync(INDEX).expect("the state reads");
    assert!(
        status.enabled && !status.active,
        "a fresh epoch waits for a device: {status:?}"
    );
    let epoch = status.epoch.expect("sync on holds an epoch");
    assert!(
        epoch.len() == 32
            && epoch
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')),
        "the epoch {epoch} is 32 lowercase hexadecimal digits"
    );
    epoch
}

#[test]
fn every_change_that_a_device_reloads_whole_gives_a_new_epoch_that_restarts_keep() {
    let scratch = ScratchDirectory::new("sync-epochs");
    let root = scratch.path().join("data");
    let mut narsil = Narsil::open(log_config(&root)).expect("the engine opens");
    narsil
        .create_index(INDEX, index_config())
        .expect("the index is made");
    for id in ids("n", 40) {
        narsil
            .insert(INDEX, note_of(&id), Some(&id))
            .expect("the insert applies");
    }
    let limits = SyncSetting {
        enabled: true,
        history_max_age_ms: Some(60_000),
        history_max_bytes: Some(1_000_000),
    };
    narsil.update_sync(INDEX, &limits).expect("sync goes on");
    let mut seen = vec![epoch_of(&narsil)];
    narsil.shutdown().expect("the engine shuts down");
    narsil = Narsil::open(log_config(&root)).expect("the engine reopens");
    let reopened = narsil.get_sync(INDEX).expect("the state reads");
    assert_eq!(
        reopened.epoch.as_ref(),
        seen.last(),
        "a restart keeps the epoch"
    );
    assert_eq!(
        (reopened.history_max_age_ms, reopened.history_max_bytes),
        (Some(60_000), Some(1_000_000)),
        "a restart keeps the limits"
    );
    let wider = SyncSetting {
        history_max_bytes: Some(2_000_000),
        ..limits.clone()
    };
    narsil
        .update_sync(INDEX, &wider)
        .expect("the limits change");
    assert_eq!(
        epoch_of(&narsil).as_str(),
        seen[0],
        "a new limit keeps the epoch"
    );
    let mut archive = Vec::new();
    narsil
        .snapshot(INDEX, &mut archive)
        .expect("the snapshot is written");
    assert!(
        archive
            .windows(32)
            .any(|window| window == seen[0].as_bytes()),
        "the snapshot configuration carries the epoch"
    );
    narsil
        .update_partition_config(
            INDEX,
            &PartitionConfig {
                max_partitions: Some(3),
                ..PartitionConfig::default()
            },
        )
        .expect("the partition limit rises");
    narsil.clear(INDEX).expect("the clear applies");
    seen.push(epoch_of(&narsil));
    narsil.rebalance(INDEX, 3).expect("the rebalance applies");
    seen.push(epoch_of(&narsil));
    narsil
        .restore(INDEX, &mut Cursor::new(&archive))
        .expect("the restore applies");
    seen.push(epoch_of(&narsil));
    let restored = narsil.get_sync(INDEX).expect("the state reads");
    assert_eq!(
        restored.history_max_bytes,
        Some(2_000_000),
        "a restore keeps the setting"
    );
    assert_eq!(
        narsil.count_documents(INDEX).expect("the count answers"),
        40
    );
    narsil.shutdown().expect("the engine shuts down");
    narsil = Narsil::open(log_config(&root)).expect("the engine reopens");
    assert_eq!(
        epoch_of(&narsil).as_str(),
        seen[3],
        "a restart keeps the restored epoch"
    );
    narsil
        .update_sync(INDEX, &SyncSetting::default())
        .expect("sync goes off");
    assert_eq!(
        narsil.get_sync(INDEX).expect("the state reads"),
        SyncStatus::default()
    );
    narsil
        .update_sync(INDEX, &limits)
        .expect("sync goes on again");
    seen.push(epoch_of(&narsil));
    let mut distinct = seen.clone();
    distinct.sort();
    distinct.dedup();
    assert_eq!(
        distinct.len(),
        seen.len(),
        "every renewal draws another epoch: {seen:?}"
    );
    narsil.shutdown().expect("the engine shuts down");
}

#[test]
fn a_directory_that_the_reference_synced_keeps_its_history_and_snapshot_both_ways() {
    let synced = synced_by_reference("sync-interop");
    let history_before = history_files(&synced.root);
    assert!(
        !history_before.is_empty(),
        "the reference moved log segments into history"
    );
    assert!(
        published_file(&synced.root).exists(),
        "the reference published a snapshot"
    );
    let narsil = Narsil::open(log_config(&synced.root)).expect("the crate opens the directory");
    let status = narsil.get_sync(INDEX).expect("the state reads");
    assert_eq!(
        (status.enabled, status.active, status.epoch.as_deref()),
        (true, true, Some(synced.epoch.as_str())),
        "the crate keeps the reference's sync state"
    );
    for kept in &history_before {
        assert!(
            kept.exists(),
            "the crate keeps history file {}",
            kept.display()
        );
    }
    let written = ids("r", 150);
    for id in &written {
        narsil
            .insert(INDEX, rust_note_of(id), Some(id))
            .expect("the insert applies");
    }
    narsil.checkpoint(INDEX).expect("the checkpoint applies");
    let history_after = history_files(&synced.root);
    assert!(
        history_after.len() > history_before.len(),
        "the crate's checkpoint moves covered log segments into history"
    );
    let oracle = oracle_of(&synced, &written);
    require_documents(&narsil, &oracle);
    narsil.shutdown().expect("the engine shuts down");
    require_reference_reads(&synced, &oracle, &status);
}

#[test]
fn history_limits_delete_old_segments_only_after_a_snapshot_covers_them() {
    let synced = synced_by_reference("sync-retention");
    let narsil = Narsil::open(log_config(&synced.root)).expect("the crate opens the directory");
    let tight = SyncSetting {
        enabled: true,
        history_max_age_ms: None,
        history_max_bytes: Some(1),
    };
    narsil
        .update_sync(INDEX, &tight)
        .expect("the limit changes");
    let written = ids("r", 150);
    for id in &written {
        narsil
            .insert(INDEX, rust_note_of(id), Some(id))
            .expect("the insert applies");
    }
    let published_before =
        std::fs::read(published_file(&synced.root)).expect("a snapshot is published");
    narsil.checkpoint(INDEX).expect("the checkpoint applies");
    let started = Instant::now();
    while !history_files(&synced.root).is_empty() {
        assert!(
            started.elapsed() < RETENTION_WAIT,
            "the history limit deleted no segment: {:?}",
            history_files(&synced.root)
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    let published_after =
        std::fs::read(published_file(&synced.root)).expect("a snapshot stays published");
    assert_ne!(
        published_before, published_after,
        "the engine republished before deleting history"
    );
    let status = narsil.get_sync(INDEX).expect("the state reads");
    assert_eq!(
        status.epoch.as_deref(),
        Some(synced.epoch.as_str()),
        "retention keeps the epoch"
    );
    let oracle = oracle_of(&synced, &written);
    require_documents(&narsil, &oracle);
    narsil.shutdown().expect("the engine shuts down");
    require_reference_reads(&synced, &oracle, &status);
}

#[test]
fn sync_off_releases_the_snapshot_and_history_and_keeps_every_document() {
    let synced = synced_by_reference("sync-release");
    let narsil = Narsil::open(log_config(&synced.root)).expect("the crate opens the directory");
    narsil
        .update_sync(INDEX, &SyncSetting::default())
        .expect("sync goes off");
    assert!(
        history_files(&synced.root).is_empty(),
        "sync off deletes the history"
    );
    assert!(
        !published_file(&synced.root).exists(),
        "sync off deletes the snapshot"
    );
    let oracle = oracle_of(&synced, &[]);
    require_documents(&narsil, &oracle);
    narsil.shutdown().expect("the engine shuts down");
    let reopened = Narsil::open(log_config(&synced.root)).expect("the engine reopens");
    assert_eq!(
        reopened.get_sync(INDEX).expect("the state reads"),
        SyncStatus::default()
    );
    require_documents(&reopened, &oracle);
    reopened.shutdown().expect("the engine shuts down");
    require_reference_reads(&synced, &oracle, &SyncStatus::default());
}

#[test]
fn sync_crash_child_writer() {
    let Ok(directory) = std::env::var(CHILD_DIRECTORY) else {
        return;
    };
    let mut config = log_config(Path::new(&directory));
    if let Some(durability) = config.durability.as_mut() {
        durability.checkpoint_mutation_threshold = Some(9);
    }
    let narsil = Narsil::open(config).expect("the child opens");
    let mut out = std::io::stdout().lock();
    for step in 0..u64::MAX {
        let id = format!("c{step}");
        narsil
            .insert(INDEX, rust_note_of(&id), Some(&id))
            .expect("the child's insert applies");
        writeln!(out, "ACK {step}").expect("the child writes");
        out.flush().expect("the child flushes");
    }
}

fn killed_after(root: &Path, acknowledgements: usize) -> Option<u64> {
    let mut child = Command::new(std::env::current_exe().expect("the test binary has a path"))
        .args([
            "--exact",
            "sync_crash_child_writer",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD_DIRECTORY, root)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("the child starts");
    let stdout = child.stdout.take().expect("the child's output is piped");
    let mut last = None;
    let mut seen = 0;
    for line in BufReader::new(stdout).lines() {
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
    last
}

fn segment_starts(directory: &Path, history: bool) -> Vec<u64> {
    let mut starts: Vec<u64> = files_under(directory)
        .iter()
        .filter_map(|path| path.file_name()?.to_str().map(str::to_string))
        .filter_map(|name| {
            let start = if history {
                name.split_once('-')?.0.to_string()
            } else {
                name
            };
            (start.len() == 16).then(|| start.parse().ok()).flatten()
        })
        .collect();
    starts.sort_unstable();
    starts
}

#[test]
fn a_crash_while_checkpoints_move_history_loses_no_acknowledged_write() {
    let synced = synced_by_reference("sync-crash");
    let last =
        killed_after(&synced.root, CRASH_ACKNOWLEDGEMENTS).expect("the child acknowledged writes");
    let narsil = Narsil::open(log_config(&synced.root)).expect("the crate recovers the directory");
    let status = narsil.get_sync(INDEX).expect("the state reads");
    assert_eq!(
        status.epoch.as_deref(),
        Some(synced.epoch.as_str()),
        "the crash keeps the epoch"
    );
    let acknowledged: Vec<String> = (0..=last).map(|step| format!("c{step}")).collect();
    let mut oracle = oracle_of(&synced, &acknowledged);
    let mut unacknowledged = last + 1;
    loop {
        let id = format!("c{unacknowledged}");
        if !narsil.has(INDEX, &id).expect("the lookup answers") {
            break;
        }
        oracle.insert(id.clone(), rust_note_of(&id));
        unacknowledged += 1;
    }
    require_documents(&narsil, &oracle);
    let partitions = files_under(&synced.root.join(INDEX).join("history"))
        .iter()
        .filter_map(|path| path.parent().map(Path::to_path_buf))
        .collect::<std::collections::BTreeSet<_>>();
    assert!(
        !partitions.is_empty(),
        "the child's checkpoints moved segments into history"
    );
    for partition in partitions {
        let Some(partition_id) = partition.file_name() else {
            continue;
        };
        let history = segment_starts(&partition, true);
        let log = segment_starts(
            &synced.root.join(INDEX).join("wal").join(partition_id),
            false,
        );
        let mut distinct = history.clone();
        distinct.dedup();
        assert_eq!(distinct, history, "no segment sits in history twice");
        if let (Some(newest_moved), Some(oldest_live)) = (history.last(), log.first()) {
            assert!(
                newest_moved < oldest_live,
                "history holds only segments older than the log"
            );
        }
    }
    narsil.shutdown().expect("the engine shuts down");
    require_reference_reads(&synced, &oracle, &status);
}
