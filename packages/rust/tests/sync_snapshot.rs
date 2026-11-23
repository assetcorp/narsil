mod support;

use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};

use narsil::{
    Bm25Params, ChangePosition, ChangesSetting, DurabilityConfig, FeedChange, IndexConfig, Map,
    Narsil, NarsilConfig, NarsilEvent, NarsilEventKind, PartitionConfig, SyncCursor, SyncRead,
    SyncSetting, SyncSnapshot, SynonymRule, Value, parse_json, write_json,
};
use support::{ScratchDirectory, repository_root};

const INDEX: &str = "notes";
const ODD_CHUNK_BYTES: usize = 777;
const FIRST_NOTES: usize = 200;
const LATER_NOTES: usize = 50;
const RANGE_START: u64 = 1_000;
const RANGE_END: u64 = 5_999;
const FEED_HISTORY_MAX_BYTES: u64 = 1_073_741_824;

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
        Value::String(format!("written for the device as {id}")),
    );
    note
}

fn index_config() -> IndexConfig {
    IndexConfig {
        schema: parse_json(r#"{"title":"string","body":"string"}"#).unwrap(),
        ..IndexConfig::default()
    }
}

fn ids(prefix: &str, count: usize) -> Vec<String> {
    (0..count).map(|at| format!("{prefix}{at}")).collect()
}

fn synced_engine(root: &Path, notes: &[String]) -> Narsil {
    let on = SyncSetting {
        enabled: true,
        ..SyncSetting::default()
    };
    synced_engine_with(root, notes, &on)
}

fn synced_engine_with(root: &Path, notes: &[String], setting: &SyncSetting) -> Narsil {
    let narsil = Narsil::open(log_config(root)).expect("the log tier opens");
    narsil.create_index(INDEX, index_config()).unwrap();
    for id in notes {
        narsil.insert(INDEX, note_of(id), Some(id)).unwrap();
    }
    narsil.update_sync(INDEX, setting).expect("sync goes on");
    narsil
}

fn archive_of(snapshot: &SyncSnapshot) -> Vec<u8> {
    let mut archive = Vec::new();
    let mut chunk = vec![0u8; ODD_CHUNK_BYTES];
    loop {
        let read = snapshot
            .read_at(archive.len() as u64, &mut chunk)
            .expect("the archive reads");
        if read == 0 {
            break;
        }
        archive.extend_from_slice(&chunk[..read]);
    }
    assert_eq!(archive.len() as u64, snapshot.byte_length());
    archive
}

fn reference_download(directory: &Path, archive: &Path, wanted: &[String], scratch: &Path) -> Map {
    let mut spec = Map::new();
    spec.insert(
        "directory",
        Value::String(directory.to_string_lossy().into_owned()),
    );
    spec.insert(
        "crateArchive",
        Value::String(archive.to_string_lossy().into_owned()),
    );
    spec.insert("rangeStart", Value::Number(RANGE_START as f64));
    spec.insert("rangeEnd", Value::Number(RANGE_END as f64));
    spec.insert(
        "ids",
        Value::Array(wanted.iter().cloned().map(Value::String).collect()),
    );
    let spec_path = scratch.join("download-spec.json");
    std::fs::write(&spec_path, write_json(&Value::Object(spec))).unwrap();
    let script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/reference_sync_download.mjs");
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
    match parse_json(&String::from_utf8(output.stdout).unwrap()).unwrap() {
        Value::Object(outcome) => outcome,
        _ => panic!("the reference wrote no object"),
    }
}

#[test]
#[cfg_attr(
    all(windows, target_arch = "aarch64"),
    ignore = "the reference HTTP server cannot start: uWebSockets.js ships no uws_win32_arm64 binary"
)]
fn a_device_downloads_the_same_snapshot_from_the_crate_and_the_reference_server() {
    let scratch = ScratchDirectory::new("sync-snapshot-download");
    let root = scratch.path().join("data");
    let first = ids("n", FIRST_NOTES);
    let narsil = synced_engine(&root, &first);
    assert!(!narsil.get_sync(INDEX).unwrap().active);

    let snapshot = narsil.sync_snapshot(INDEX).expect("the snapshot publishes");
    let archive = archive_of(&snapshot);
    let tag = snapshot.entity_tag().to_string();
    assert_eq!(tag.len(), 64);
    assert_eq!(
        Some(snapshot.epoch()),
        narsil.get_sync(INDEX).unwrap().epoch.as_deref()
    );
    assert!(
        narsil.get_sync(INDEX).unwrap().active,
        "a download activates sync"
    );
    drop(snapshot);

    for id in ids("l", LATER_NOTES) {
        narsil.insert(INDEX, note_of(&id), Some(&id)).unwrap();
    }
    narsil.checkpoint(INDEX).unwrap();
    let again = narsil.sync_snapshot(INDEX).unwrap();
    assert_eq!(
        again.entity_tag(),
        tag,
        "later writes keep the published snapshot"
    );
    assert_eq!(archive_of(&again), archive);
    drop(again);
    narsil.shutdown().unwrap();

    let archive_path = scratch.path().join("crate-archive.tar");
    std::fs::write(&archive_path, &archive).unwrap();
    let mut wanted = first.clone();
    wanted.extend(ids("l", LATER_NOTES));
    let outcome = reference_download(&root, &archive_path, &wanted, scratch.path());
    assert_eq!(outcome.get("status"), Some(&Value::Number(200.0)));
    assert_eq!(
        outcome.get("etag"),
        Some(&Value::String(format!("\"{tag}\"")))
    );
    assert_eq!(
        outcome.get("sameBytes"),
        Some(&Value::Bool(true)),
        "{outcome:?}"
    );
    assert_eq!(outcome.get("rangeStatus"), Some(&Value::Number(206.0)));
    assert_eq!(outcome.get("sameRange"), Some(&Value::Bool(true)));
    assert_eq!(outcome.get("syncActive"), Some(&Value::Bool(true)));
    assert_eq!(
        outcome.get("count"),
        Some(&Value::Number(FIRST_NOTES as f64))
    );
    let Some(Value::Array(held)) = outcome.get("held") else {
        panic!("the reference lists the documents of the copy");
    };
    assert_eq!(
        held.len(),
        FIRST_NOTES,
        "the copy holds the notes from before the download"
    );
    for entry in held {
        let Value::Object(entry) = entry else {
            panic!("each held entry is an object");
        };
        let Some(Value::String(id)) = entry.get("id") else {
            panic!("each held entry has an id");
        };
        assert!(
            first.contains(id),
            "the copy holds {id} from before the download"
        );
        assert_eq!(entry.get("document"), Some(&Value::Object(note_of(id))));
    }
}

#[test]
fn a_download_reads_the_same_bytes_after_a_new_epoch_releases_its_snapshot() {
    let scratch = ScratchDirectory::new("sync-snapshot-pins");
    let root = scratch.path().join("data");
    let narsil = synced_engine(&root, &ids("n", FIRST_NOTES));
    let snapshot = narsil.sync_snapshot(INDEX).unwrap();
    let before = archive_of(&snapshot);
    let old_epoch = snapshot.epoch().to_string();

    narsil.clear(INDEX).unwrap();
    for id in ids("fresh", LATER_NOTES) {
        narsil.insert(INDEX, note_of(&id), Some(&id)).unwrap();
    }
    narsil.checkpoint(INDEX).unwrap();
    narsil.checkpoint(INDEX).unwrap();
    assert_eq!(
        archive_of(&snapshot),
        before,
        "the pinned files keep their bytes"
    );
    drop(snapshot);

    let next = narsil.sync_snapshot(INDEX).unwrap();
    assert_ne!(
        next.epoch(),
        old_epoch,
        "the clear gave the index a new epoch"
    );
    assert_ne!(archive_of(&next), before);
    narsil.shutdown().unwrap();
}

fn heard(narsil: &Narsil) -> Arc<Mutex<Vec<(String, FeedChange)>>> {
    let changes = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&changes);
    narsil.on(NarsilEventKind::FeedChange, move |event| {
        if let NarsilEvent::FeedChange { index_name, change } = event {
            recorded.lock().unwrap().push((index_name.clone(), *change));
        }
    });
    changes
}

#[test]
fn each_change_that_a_feed_acts_on_reaches_listeners_once_it_is_durable() {
    let scratch = ScratchDirectory::new("sync-feed-changes");
    let root = scratch.path().join("data");
    let narsil = synced_engine(&root, &ids("n", 20));
    let changes = heard(&narsil);
    let bm25 = Bm25Params {
        k1: Some(1.5),
        ..Bm25Params::default()
    };
    narsil.update_bm25(INDEX, &bm25).unwrap();
    narsil
        .update_synonyms(
            INDEX,
            &[SynonymRule::TwoWay(vec!["note".into(), "memo".into()])],
        )
        .unwrap();
    narsil.clear(INDEX).unwrap();
    let archive = {
        let snapshot = narsil.sync_snapshot(INDEX).unwrap();
        archive_of(&snapshot)
    };
    narsil.restore(INDEX, &mut archive.as_slice()).unwrap();
    let two_partitions = PartitionConfig {
        max_partitions: Some(2),
        ..PartitionConfig::default()
    };
    narsil
        .update_partition_config(INDEX, &two_partitions)
        .unwrap();
    narsil.rebalance(INDEX, 2).unwrap();
    let recording = ChangesSetting {
        enabled: true,
        previous_document: true,
        ..ChangesSetting::default()
    };
    narsil.update_changes(INDEX, &recording).unwrap();
    let plain = ChangesSetting {
        enabled: true,
        ..ChangesSetting::default()
    };
    narsil.update_changes(INDEX, &plain).unwrap();
    narsil
        .update_changes(INDEX, &ChangesSetting::default())
        .unwrap();
    narsil.update_sync(INDEX, &SyncSetting::default()).unwrap();
    narsil.update_bm25(INDEX, &Bm25Params::default()).unwrap();
    narsil.drop_index(INDEX).unwrap();

    let wanted: Vec<(String, FeedChange)> = [
        FeedChange::Settings,
        FeedChange::Settings,
        FeedChange::Epoch,
        FeedChange::Epoch,
        FeedChange::Epoch,
        FeedChange::PreviousDocumentOff,
        FeedChange::ChangesOff,
        FeedChange::SyncOff,
        FeedChange::Dropped,
    ]
    .into_iter()
    .map(|change| (INDEX.to_string(), change))
    .collect();
    assert_eq!(*changes.lock().unwrap(), wanted);
    narsil.shutdown().unwrap();
}

fn read_all(narsil: &Narsil, partition_id: u32, after: u64, up_to: u64) -> Vec<u64> {
    let mut cursor = SyncCursor::after(partition_id, after);
    let mut seq_nos = Vec::new();
    loop {
        match narsil
            .read_sync_entries(INDEX, &mut cursor, up_to, 1)
            .unwrap()
        {
            SyncRead::HistoryGone => panic!("the history holds every entry since the download"),
            SyncRead::Entries(entries) if entries.is_empty() => return seq_nos,
            SyncRead::Entries(entries) => {
                assert_eq!(entries.len(), 1, "a read of one byte takes one entry");
                assert!(!entries[0].payload.is_empty());
                seq_nos.push(entries[0].seq_no);
            }
        }
    }
}

#[test]
fn the_feed_reader_returns_every_durable_entry_since_the_download_after_a_restart() {
    let scratch = ScratchDirectory::new("sync-feed-reader");
    let root = scratch.path().join("data");
    let roomy_history = SyncSetting {
        enabled: true,
        history_max_bytes: Some(FEED_HISTORY_MAX_BYTES),
        ..SyncSetting::default()
    };
    let narsil = synced_engine_with(&root, &[], &roomy_history);
    let epoch = narsil.sync_snapshot(INDEX).unwrap().epoch().to_string();
    let written = ids("w", 30);
    for id in &written {
        narsil.insert(INDEX, note_of(id), Some(id)).unwrap();
    }
    narsil.checkpoint(INDEX).unwrap();
    let state = narsil.sync_feed_state(INDEX).unwrap().expect("sync is on");
    assert_eq!(state.epoch, epoch);
    assert_eq!(state.partition_count, 1);
    assert_eq!(
        state.settings.get("language"),
        Some(&Value::String("english".into()))
    );
    let bounds = narsil.sync_bounds(INDEX, 0).unwrap();
    assert_eq!(bounds.head, written.len() as u64);
    assert_eq!(bounds.oldest_seq_no, 1);
    narsil.shutdown().unwrap();

    let narsil = Narsil::open(log_config(&root)).unwrap();
    let wanted: Vec<u64> = (1..=written.len() as u64).collect();
    assert_eq!(read_all(&narsil, 0, 0, bounds.head), wanted);
    assert_eq!(read_all(&narsil, 0, 10, bounds.head), wanted[10..].to_vec());
    let mut sizing = SyncCursor::after(0, 0);
    let SyncRead::Entries(first) = narsil
        .read_sync_entries(INDEX, &mut sizing, 2, usize::MAX)
        .unwrap()
    else {
        panic!("the history holds the first two entries");
    };
    let two_entries: usize = first.iter().map(|entry| entry.payload.len()).sum();
    for (budget, taken) in [(two_entries - 1, 1), (two_entries, 2)] {
        let mut cursor = SyncCursor::after(0, 0);
        let SyncRead::Entries(entries) = narsil
            .read_sync_entries(INDEX, &mut cursor, bounds.head, budget)
            .unwrap()
        else {
            panic!("the history holds every entry");
        };
        assert_eq!(
            entries.len(),
            taken,
            "a read of {budget} bytes stops before the entry that would pass the budget"
        );
        assert_eq!(cursor.position(), taken as u64);
    }
    let start = ChangePosition {
        partition_id: 0,
        seq_no: 0,
    };
    let caught_up = ChangePosition {
        partition_id: 0,
        seq_no: bounds.head,
    };
    assert!(narsil.sync_bytes_behind(INDEX, &[start]).unwrap() > 0);
    assert_eq!(narsil.sync_bytes_behind(INDEX, &[caught_up]).unwrap(), 0);
    assert!(narsil.sync_snapshot_bytes(INDEX).unwrap() > 0);
    narsil.update_sync(INDEX, &SyncSetting::default()).unwrap();
    assert_eq!(narsil.sync_feed_state(INDEX).unwrap(), None);
    assert_eq!(
        narsil.sync_snapshot(INDEX).err().map(|error| error.code()),
        Some(narsil::ErrorCode::SYNC_NOT_ENABLED)
    );
    narsil.shutdown().unwrap();
}
