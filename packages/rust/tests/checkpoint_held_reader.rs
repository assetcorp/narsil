mod support;

use std::fs::File;
use std::path::Path;
use std::sync::mpsc::{RecvTimeoutError, channel};
use std::time::{Duration, Instant};

use narsil::{DurabilityConfig, DurabilityMode, IndexConfig, Map, Narsil, NarsilConfig, Value};
use support::ScratchDirectory;

const INDEX: &str = "ledgers";
const ENTRIES: usize = 200;
const STAGED_META_PREFIX: &str = "meta.tmp-";
const STAGED_META_POLL: Duration = Duration::from_millis(1);
const STAGED_META_DEADLINE: Duration = Duration::from_secs(60);
const READER_HOLDS_AFTER_STAGING: Duration = Duration::from_secs(1);
const CHECKPOINT_DEADLINE: Duration = Duration::from_secs(60);
const BEYOND_EVERY_MUTATION: u64 = 1_000_000_000;

fn ledger_title(entry: usize) -> String {
    format!("ledger entry {entry}")
}

fn open_engine(root: &Path) -> Narsil {
    Narsil::open(NarsilConfig {
        durability: Some(DurabilityConfig {
            directory: Some(root.to_path_buf()),
            mode: Some(DurabilityMode::Sync),
            checkpoint_mutation_threshold: Some(BEYOND_EVERY_MUTATION),
            ..DurabilityConfig::default()
        }),
        ..NarsilConfig::default()
    })
    .expect("the engine opens")
}

#[cfg(windows)]
fn hold_open(path: &Path) -> File {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ_AND_WRITE: u32 = 0x1 | 0x2;
    std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ_AND_WRITE)
        .open(path)
        .expect("the outside reader opens the meta file without sharing its deletion")
}

#[cfg(not(windows))]
fn hold_open(path: &Path) -> File {
    File::open(path).expect("the outside reader opens the meta file")
}

fn staged_meta_waiting(index_directory: &Path) -> bool {
    std::fs::read_dir(index_directory).is_ok_and(|entries| {
        entries.flatten().any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(STAGED_META_PREFIX)
        })
    })
}

#[test]
fn a_checkpoint_saves_once_an_outside_reader_closes_the_meta_file_it_held_open() {
    let root = ScratchDirectory::new("checkpoint-held-reader");
    let engine = open_engine(root.path());
    let mut schema = Map::new();
    schema.insert("title", Value::String("string".into()));
    engine
        .create_index(
            INDEX,
            IndexConfig {
                schema: Value::Object(schema),
                ..IndexConfig::default()
            },
        )
        .expect("the index is created");
    let entries = (0..ENTRIES)
        .map(|entry| {
            let mut document = Map::new();
            document.insert("id", Value::String(format!("entry-{entry}")));
            document.insert("title", Value::String(ledger_title(entry)));
            document
        })
        .collect();
    let inserted = engine
        .insert_batch(INDEX, entries)
        .expect("the entries insert");
    assert!(inserted.failed.is_empty(), "{:?}", inserted.failed);

    let index_directory = root.path().join(INDEX);
    let meta_path = index_directory.join("meta");
    let before = std::fs::read(&meta_path).expect("the index wrote its meta file");
    let reader = hold_open(&meta_path);

    let outcome = std::thread::scope(|scope| {
        let (sender, saved) = channel();
        let engine = &engine;
        scope.spawn(move || {
            let _ = sender.send(engine.checkpoint(INDEX));
        });
        let deadline = Instant::now() + STAGED_META_DEADLINE;
        let mut staged_at: Option<Instant> = None;
        let mut finished_while_held = None;
        while finished_while_held.is_none() && Instant::now() < deadline {
            if staged_at.is_some_and(|at| at.elapsed() >= READER_HOLDS_AFTER_STAGING) {
                break;
            }
            match saved.recv_timeout(STAGED_META_POLL) {
                Ok(outcome) => finished_while_held = Some(outcome),
                Err(RecvTimeoutError::Timeout) => {
                    if staged_at.is_none() && staged_meta_waiting(&index_directory) {
                        staged_at = Some(Instant::now());
                    }
                }
                Err(RecvTimeoutError::Disconnected) => {
                    panic!("the checkpoint thread ended without an answer")
                }
            }
        }
        drop(reader);
        if cfg!(windows)
            && let Some(outcome) = &finished_while_held
        {
            panic!(
                "the checkpoint finished while an outside reader held the meta file, with {outcome:?}"
            );
        }
        match finished_while_held {
            Some(outcome) => outcome,
            None => saved
                .recv_timeout(CHECKPOINT_DEADLINE)
                .expect("the checkpoint answers once the outside reader closes the meta file"),
        }
    });
    outcome.expect("the checkpoint saves once the outside reader closes the meta file");
    let after = std::fs::read(&meta_path).expect("the meta file reads after the checkpoint");
    assert_ne!(
        before, after,
        "the checkpoint left the meta file as it was before the entries arrived"
    );
    engine.shutdown().expect("the engine shuts down");
    drop(engine);

    let reopened = open_engine(root.path());
    for entry in 0..ENTRIES {
        let document = reopened
            .get(INDEX, &format!("entry-{entry}"))
            .expect("the entry reads")
            .unwrap_or_else(|| panic!("entry {entry} is missing after the restart"));
        assert_eq!(
            document.get("title"),
            Some(&Value::String(ledger_title(entry))),
            "entry {entry} came back with another title"
        );
    }
    reopened.shutdown().expect("the reopened engine shuts down");
}

#[cfg(windows)]
#[test]
fn a_reader_that_outlasts_the_retries_gets_a_typed_error_and_every_acknowledged_write_survives() {
    let root = ScratchDirectory::new("checkpoint-held-timeout");
    let engine = open_engine(root.path());
    let mut schema = Map::new();
    schema.insert("title", Value::String("string".into()));
    engine
        .create_index(
            INDEX,
            IndexConfig {
                schema: Value::Object(schema),
                ..IndexConfig::default()
            },
        )
        .expect("the index is created");
    let mut document = Map::new();
    document.insert("id", Value::String("retained".into()));
    document.insert("title", Value::String("acknowledged ledger".into()));
    engine
        .insert_batch(INDEX, vec![document])
        .expect("the write is acknowledged");
    let index_directory = root.path().join(INDEX);
    let reader = hold_open(&index_directory.join("meta"));
    let error = engine
        .checkpoint(INDEX)
        .expect_err("the checkpoint saved while the reader still held the meta file");
    assert_eq!(error.code(), narsil::ErrorCode::PERSISTENCE_SAVE_FAILED);
    assert!(
        !staged_meta_waiting(&index_directory),
        "the failed checkpoint left its staged meta file behind"
    );
    drop(reader);
    let _ = engine.shutdown();
    drop(engine);
    let reopened = open_engine(root.path());
    let document = reopened
        .get(INDEX, "retained")
        .expect("the document reads")
        .expect("the acknowledged document is missing after the restart");
    assert_eq!(
        document.get("title"),
        Some(&Value::String("acknowledged ledger".into()))
    );
    reopened.shutdown().expect("the reopened engine shuts down");
}
