mod support;

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use narsil::{ErrorCode, Map, Narsil, QueryParams, SearchMode, Value, VectorQuery};
use support::ScratchDirectory;
use support::portable::{
    Tier, document_of, documents, every_id, fill, held_documents, index_config, snapshot_of,
    source_engine, with_id,
};

const CHILD_DIRECTORY: &str = "NARSIL_RESTORE_CHILD_DIRECTORY";
const KILL_ROUNDS: u64 = 6;
const RACING_WRITERS: usize = 4;
const TAR_END_BYTES: usize = 1_024;

fn words_of(document: &Map) -> Vec<String> {
    let mut words = Vec::new();
    if let Some(Value::String(title)) = document.get("title") {
        words.extend(title.split_whitespace().map(str::to_lowercase));
    }
    if let Some(Value::Array(tags)) = document.get("tags") {
        words.extend(tags.iter().filter_map(Value::as_str).map(str::to_lowercase));
    }
    words
}

fn require_term_count(narsil: &Narsil, index: &str, word: &str, held: &BTreeMap<String, Map>) {
    let expected = held
        .values()
        .filter(|document| words_of(document).iter().any(|found| found == word))
        .count() as u64;
    let params = QueryParams {
        term: Some(word.to_string()),
        limit: Some(1),
        ..QueryParams::default()
    };
    let found = narsil.query(index, &params).expect("the term query runs");
    assert_eq!(found.count, expected, "documents that hold \"{word}\"");
}

fn require_vector_match(narsil: &Narsil, index: &str, id: &str, document: &Map) {
    let Some(Value::Array(values)) = document.get("embedding") else {
        return;
    };
    let value = values
        .iter()
        .map(|item| item.as_f64().expect("a number") as f32)
        .collect();
    let params = QueryParams {
        mode: Some(SearchMode::Vector),
        limit: Some(1),
        vector: Some(VectorQuery {
            field: "embedding".to_string(),
            value: Some(value),
            text: None,
            similarity: None,
            metric: None,
            ef_search: None,
            oversample: None,
        }),
        ..QueryParams::default()
    };
    let found = narsil.query(index, &params).expect("the vector query runs");
    assert_eq!(found.hits.first().map(|hit| hit.id.as_str()), Some(id));
}

#[test]
fn a_snapshot_restores_whole_on_every_tier_and_keeps_later_writes_across_a_restart() {
    let original = documents("doc", 0..300);
    let archive = snapshot_of(&source_engine(&original), "source");
    for tier in [Tier::Memory, Tier::Log, Tier::Snapshot] {
        let root = ScratchDirectory::new("restore-tier");
        let target = tier.open(root.path());
        target
            .restore("copy", &mut archive.as_slice())
            .expect("the archive restores");
        let ids = every_id([&original]);
        assert_eq!(held_documents(&target, "copy", &ids), original, "{tier:?}");
        require_term_count(&target, "copy", "harbour", &original);
        let (probe_id, probe) = document_of("doc", 42);
        require_vector_match(&target, "copy", &probe_id, &probe);
        if !tier.durable() {
            continue;
        }
        let added = documents("added", 0..40);
        fill(&target, "copy", &added);
        let removed: Vec<String> = original.keys().take(25).cloned().collect();
        for id in &removed {
            target.remove("copy", id).expect("the removal applies");
        }
        if matches!(tier, Tier::Snapshot) {
            target.checkpoint("copy").expect("the checkpoint writes");
        }
        target.shutdown().expect("the engine shuts down");
        drop(target);
        let reopened = tier.open(root.path());
        let mut expected = original.clone();
        for id in &removed {
            expected.remove(id);
        }
        expected.extend(added.clone());
        let ids = every_id([&original, &added]);
        assert_eq!(
            held_documents(&reopened, "copy", &ids),
            expected,
            "{tier:?}"
        );
        assert_eq!(
            reopened.count_documents("copy").expect("the count reads"),
            expected.len() as u64
        );
        require_term_count(&reopened, "copy", "harbour", &expected);
    }
}

fn damaged_copies(archive: &[u8]) -> Vec<(&'static str, Vec<u8>)> {
    let mut config_flipped = archive.to_vec();
    if let Some(byte) = config_flipped.get_mut(600) {
        *byte ^= 0xff;
    }
    vec![
        ("empty", Vec::new()),
        (
            "not an archive",
            b"these bytes hold no snapshot at all".to_vec(),
        ),
        ("cut in half", archive[..archive.len() / 2].to_vec()),
        (
            "cut inside its last file",
            archive[..archive.len() - TAR_END_BYTES - 1].to_vec(),
        ),
        ("configuration damaged", config_flipped),
    ]
}

#[test]
fn a_refused_restore_leaves_the_index_as_it_was_and_a_good_one_replaces_it() {
    let first = documents("first", 0..120);
    let second = documents("second", 0..80);
    let archive = snapshot_of(&source_engine(&second), "source");
    let ids = every_id([&first, &second]);
    for tier in [Tier::Memory, Tier::Log, Tier::Snapshot] {
        let root = ScratchDirectory::new("restore-refused");
        let target = tier.open(root.path());
        target
            .create_index("copy", index_config())
            .expect("the index is created");
        fill(&target, "copy", &first);
        for (label, bytes) in damaged_copies(&archive) {
            let refused = target.restore("copy", &mut bytes.as_slice());
            assert!(refused.is_err(), "{tier:?}: the {label} archive restored");
            assert_eq!(
                held_documents(&target, "copy", &ids),
                first,
                "{tier:?}: the {label} archive changed the index"
            );
        }
        target
            .restore("copy", &mut archive.as_slice())
            .expect("the archive restores");
        assert_eq!(held_documents(&target, "copy", &ids), second, "{tier:?}");
        if !tier.durable() {
            continue;
        }
        target.shutdown().expect("the engine shuts down");
        drop(target);
        let reopened = tier.open(root.path());
        assert_eq!(held_documents(&reopened, "copy", &ids), second, "{tier:?}");
    }
}

#[test]
fn writes_racing_a_restore_reach_only_the_index_that_holds_the_name() {
    let first = documents("first", 0..200);
    let second = documents("second", 0..150);
    let archive = snapshot_of(&source_engine(&second), "source");
    let root = ScratchDirectory::new("restore-race");
    let target = Arc::new(Tier::Log.open(root.path()));
    target
        .create_index("copy", index_config())
        .expect("the index is created");
    fill(&target, "copy", &first);
    let stop = Arc::new(AtomicBool::new(false));
    let restored = Arc::new(AtomicBool::new(false));
    let acknowledged = Arc::new(Mutex::new(Vec::new()));
    let writers: Vec<_> = (0..RACING_WRITERS)
        .map(|writer| {
            let (target, stop, restored) = (target.clone(), stop.clone(), restored.clone());
            let acknowledged = acknowledged.clone();
            std::thread::spawn(move || {
                let mut seed = 0;
                while !stop.load(Ordering::SeqCst) {
                    let (id, document) = document_of(&format!("w{writer}"), seed);
                    seed += 1;
                    let after_restore = restored.load(Ordering::SeqCst);
                    match target.insert("copy", with_id(&id, &document), None) {
                        Ok(_) => acknowledged.lock().expect("the list locks").push((
                            id,
                            document,
                            after_restore,
                        )),
                        Err(error) => assert_eq!(error.code(), ErrorCode::INDEX_NOT_FOUND),
                    }
                }
            })
        })
        .collect();
    std::thread::sleep(Duration::from_millis(50));
    target
        .restore("copy", &mut archive.as_slice())
        .expect("the archive restores");
    restored.store(true, Ordering::SeqCst);
    std::thread::sleep(Duration::from_millis(100));
    stop.store(true, Ordering::SeqCst);
    for writer in writers {
        writer.join().expect("the writer finishes");
    }
    let acknowledged = acknowledged.lock().expect("the list locks").clone();
    let written: BTreeMap<String, Map> = acknowledged
        .iter()
        .map(|(id, document, _)| (id.clone(), document.clone()))
        .collect();
    let ids = every_id([&first, &second, &written]);
    let live = held_documents(&target, "copy", &ids);
    for (id, _, after_restore) in &acknowledged {
        assert!(
            !after_restore || live.contains_key(id),
            "the write of {id} after the restore is missing"
        );
    }
    for (id, document) in &live {
        let expected = second.get(id).or_else(|| written.get(id));
        assert_eq!(
            expected,
            Some(document),
            "{id} came from neither the archive nor a write"
        );
    }
    assert!(first.keys().all(|id| !live.contains_key(id)));
    target.shutdown().expect("the engine shuts down");
    drop(target);
    let reopened = Tier::Log.open(root.path());
    assert_eq!(held_documents(&reopened, "copy", &ids), live);
}

fn alternating_archives() -> [(BTreeMap<String, Map>, Vec<u8>); 2] {
    let first = documents("first", 0..400);
    let second = documents("second", 0..250);
    let first_archive = snapshot_of(&source_engine(&first), "source");
    let second_archive = snapshot_of(&source_engine(&second), "source");
    [(first, first_archive), (second, second_archive)]
}

#[test]
fn restore_child_process() {
    let Ok(directory) = std::env::var(CHILD_DIRECTORY) else {
        return;
    };
    let archives = alternating_archives();
    let narsil = Tier::Log.open(Path::new(&directory));
    let mut out = std::io::stdout().lock();
    for round in 0..usize::MAX {
        let (_, archive) = &archives[round % 2];
        narsil
            .restore("copy", &mut archive.as_slice())
            .expect("the child's restore succeeds");
        writeln!(out, "RESTORED {round}").expect("the child writes");
        out.flush().expect("the child flushes");
    }
}

fn kill_during_a_restore(root: &Path, wait: Duration) {
    let mut child = Command::new(std::env::current_exe().expect("the test binary has a path"))
        .args([
            "--exact",
            "restore_child_process",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD_DIRECTORY, root)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("the child starts");
    let stdout = child.stdout.take().expect("the child's output is piped");
    let mut lines = BufReader::new(stdout).lines();
    let restored = lines
        .by_ref()
        .map_while(Result::ok)
        .any(|line| line.starts_with("RESTORED"));
    assert!(restored, "the child stopped before its first restore");
    std::thread::sleep(wait);
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn a_kill_during_a_restore_leaves_one_whole_index() {
    let archives = alternating_archives();
    let ids = every_id([&archives[0].0, &archives[1].0]);
    for round in 0..KILL_ROUNDS {
        let root = ScratchDirectory::new("restore-kill");
        kill_during_a_restore(root.path(), Duration::from_millis(round * 7));
        let reopened = Tier::Log.open(root.path());
        let held = held_documents(&reopened, "copy", &ids);
        assert!(
            held == archives[0].0 || held == archives[1].0,
            "round {round}: the index holds {} documents of neither archive",
            held.len()
        );
        let count = reopened.count_documents("copy").expect("the count reads");
        assert_eq!(count, held.len() as u64, "round {round}");
    }
}
