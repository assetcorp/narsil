mod support;

use std::collections::BTreeSet;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use narsil::{
    DurabilityConfig, DurabilityMode, ErrorCode, IndexConfig, IndexLifecycleConfig,
    IndexResidencyState, Map, Narsil, NarsilConfig, QueryParams, Value,
};
use support::ScratchDirectory;

const INDEX: &str = "tickets";
const WORDS: [&str; 4] = ["boiler", "gutter", "window", "carpet"];
const CHILD_DIRECTORY: &str = "NARSIL_CLOSE_CRASH_DIRECTORY";
const CHILD_START: &str = "NARSIL_CLOSE_CRASH_START";
const WRITES_BETWEEN_CHILD_CLOSES: u64 = 3;
const WRITER_THREADS: usize = 4;
const WRITES_PER_THREAD: usize = 60;
const STATE_WAIT: Duration = Duration::from_secs(10);

fn durable(root: &Path, lifecycle: Option<IndexLifecycleConfig>) -> NarsilConfig {
    NarsilConfig {
        durability: Some(DurabilityConfig {
            directory: Some(root.to_path_buf()),
            mode: Some(DurabilityMode::Sync),
            ..DurabilityConfig::default()
        }),
        lifecycle,
        ..NarsilConfig::default()
    }
}

fn index_config() -> IndexConfig {
    let mut schema = Map::new();
    schema.insert("title", Value::String("string".into()));
    IndexConfig {
        schema: Value::Object(schema),
        ..IndexConfig::default()
    }
}

fn word_of(id: &str) -> &'static str {
    WORDS[id.bytes().map(usize::from).sum::<usize>() % WORDS.len()]
}

fn ticket(id: &str) -> Map {
    let mut document = Map::new();
    document.insert(
        "title",
        Value::String(format!("{} repair {id}", word_of(id))),
    );
    document.insert("id", Value::String(id.to_string()));
    document
}

fn found_ids(engine: &Narsil, index: &str, word: &str) -> BTreeSet<String> {
    let query = QueryParams {
        term: Some(word.to_string()),
        limit: Some(10_000),
        ..QueryParams::default()
    };
    engine
        .query(index, &query)
        .expect("the search answers")
        .hits
        .into_iter()
        .map(|hit| hit.id)
        .collect()
}

fn require_holds_exactly(engine: &Narsil, index: &str, written: &BTreeSet<String>, when: &str) {
    assert_eq!(
        engine.count_documents(index).expect("the count answers"),
        written.len() as u64,
        "the document count {when}"
    );
    let ids: Vec<String> = written.iter().cloned().collect();
    let held = engine.get_multiple(index, &ids).expect("the reads answer");
    for id in written {
        assert_eq!(held.get(id), Some(&ticket(id)), "{id} {when}");
    }
    for word in WORDS {
        let wanted: BTreeSet<String> = written
            .iter()
            .filter(|id| word_of(id) == word)
            .cloned()
            .collect();
        assert_eq!(
            found_ids(engine, index, word),
            wanted,
            "the search for {word} {when}"
        );
    }
}

fn state_of(engine: &Narsil, index: &str) -> Option<(IndexResidencyState, u64, u64)> {
    engine
        .list_indexes()
        .into_iter()
        .find(|info| info.name == index)
        .map(|info| (info.state, info.document_count, info.reopen_count))
}

fn wait_for_state(engine: &Narsil, index: &str, wanted: IndexResidencyState) {
    let started = Instant::now();
    while state_of(engine, index).map(|(state, _, _)| state) != Some(wanted) {
        assert!(
            started.elapsed() < STATE_WAIT,
            "{index} never reached {wanted:?}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn closes_and_reopens_racing_writers_and_searches_lose_no_acknowledged_write() {
    let root = ScratchDirectory::new("lifecycle-race");
    let engine = Narsil::open(durable(root.path(), None)).expect("the engine opens");
    engine.create_index(INDEX, index_config()).expect("created");
    let written = Mutex::new(BTreeSet::new());
    let writers_done = AtomicBool::new(false);
    let closes = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        let writers: Vec<_> = (0..WRITER_THREADS)
            .map(|thread| {
                let engine = &engine;
                let written = &written;
                let closes = &closes;
                scope.spawn(move || {
                    for n in 0..WRITES_PER_THREAD {
                        let waited = Instant::now();
                        while n + 1 == WRITES_PER_THREAD && closes.load(Ordering::Acquire) == 0 {
                            assert!(
                                waited.elapsed() < STATE_WAIT,
                                "the closer never closed the index"
                            );
                            std::thread::yield_now();
                        }
                        let id = format!("t{thread}-{n}");
                        engine
                            .insert(INDEX, ticket(&id), Some(&id))
                            .unwrap_or_else(|error| panic!("{id} was refused: {error:?}"));
                        written
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .insert(id);
                    }
                })
            })
            .collect();
        let closer = scope.spawn(|| {
            while !writers_done.load(Ordering::Acquire) {
                engine.close_index(INDEX).expect("the close succeeds");
                if closes.fetch_add(1, Ordering::AcqRel) % 2 == 1 {
                    engine.open_index(INDEX).expect("the open succeeds");
                }
            }
        });
        let searcher = scope.spawn(|| {
            while !writers_done.load(Ordering::Acquire) {
                for word in WORDS {
                    found_ids(&engine, INDEX, word);
                }
            }
        });
        let finished: Vec<_> = writers.into_iter().map(|writer| writer.join()).collect();
        writers_done.store(true, Ordering::Release);
        for writer in finished {
            writer.expect("a writer finishes");
        }
        closer.join().expect("the closer finishes");
        searcher.join().expect("the searcher finishes");
    });
    let written = written
        .into_inner()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    assert_eq!(written.len(), WRITER_THREADS * WRITES_PER_THREAD);
    require_holds_exactly(&engine, INDEX, &written, "after the closes");
    engine.close_index(INDEX).expect("the last close succeeds");
    engine.shutdown().expect("the engine stops");
    let reopened = Narsil::open(durable(root.path(), None)).expect("the engine opens again");
    require_holds_exactly(&reopened, INDEX, &written, "after a restart");
}

#[test]
fn close_child_writer() {
    let (Ok(directory), Ok(start)) = (std::env::var(CHILD_DIRECTORY), std::env::var(CHILD_START))
    else {
        return;
    };
    let start: u64 = start.parse().expect("the start parses");
    let engine = Narsil::open(durable(Path::new(&directory), None)).expect("the child opens");
    if engine.count_documents(INDEX).is_err() {
        engine.create_index(INDEX, index_config()).expect("created");
    }
    let mut out = std::io::stdout().lock();
    writeln!(out, "READY").expect("the child reports");
    let mut step = start;
    loop {
        let id = format!("doc-{step}");
        engine
            .insert(INDEX, ticket(&id), Some(&id))
            .expect("the child writes");
        writeln!(out, "ACK {step}").expect("the child reports");
        out.flush().expect("the child flushes");
        if step % WRITES_BETWEEN_CHILD_CLOSES == 0 {
            engine
                .close_index(INDEX)
                .expect("the child closes the index");
        }
        step += 1;
    }
}

fn acknowledged_before_kill(root: &Path, start: u64, wanted: u64) -> Vec<u64> {
    let mut child = Command::new(std::env::current_exe().expect("the test binary has a path"))
        .args([
            "--exact",
            "close_child_writer",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD_DIRECTORY, root)
        .env(CHILD_START, start.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("the child starts");
    let stdout = child.stdout.take().expect("the child's output is piped");
    let mut acknowledged = Vec::new();
    let mut lines = BufReader::new(stdout).lines();
    for line in lines.by_ref() {
        let Ok(line) = line else { break };
        if let Some(step) = line
            .strip_prefix("ACK ")
            .and_then(|step| step.trim().parse().ok())
        {
            acknowledged.push(step);
            if acknowledged.len() as u64 >= wanted {
                break;
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    for line in lines {
        let Ok(line) = line else { break };
        if let Some(step) = line
            .strip_prefix("ACK ")
            .and_then(|step| step.trim().parse().ok())
        {
            acknowledged.push(step);
        }
    }
    acknowledged
}

#[test]
fn a_kill_during_closes_keeps_every_acknowledged_write() {
    let root = ScratchDirectory::new("lifecycle-kill");
    let mut written = BTreeSet::new();
    let mut start = 0;
    for round in 0..4u64 {
        let acknowledged = acknowledged_before_kill(root.path(), start, 20 + round * 7);
        assert!(
            !acknowledged.is_empty(),
            "round {round} acknowledged nothing"
        );
        for step in &acknowledged {
            written.insert(format!("doc-{step}"));
        }
        start = acknowledged.iter().max().map_or(start, |last| last + 1);
        let engine = Narsil::open(durable(root.path(), None)).expect("the engine recovers");
        let unacknowledged = format!("doc-{start}");
        if engine
            .has(INDEX, &unacknowledged)
            .expect("the read answers")
        {
            written.insert(unacknowledged);
            start += 1;
        }
        let ids: Vec<String> = written.iter().cloned().collect();
        let found = engine.get_multiple(INDEX, &ids).expect("the reads answer");
        for id in &written {
            assert_eq!(found.get(id), Some(&ticket(id)), "round {round} lost {id}");
        }
        assert_eq!(
            engine.count_documents(INDEX).expect("the count answers"),
            written.len() as u64,
            "round {round} holds a document that no write gave"
        );
        engine.shutdown().expect("the engine stops");
    }
}

#[test]
fn every_caller_of_a_closed_index_waits_for_one_reopen() {
    let root = ScratchDirectory::new("lifecycle-callers");
    let engine = Narsil::open(durable(root.path(), None)).expect("the engine opens");
    engine.create_index(INDEX, index_config()).expect("created");
    let written: BTreeSet<String> = (0..500).map(|n| format!("doc-{n}")).collect();
    let documents = written.iter().map(|id| ticket(id)).collect();
    assert!(
        engine
            .insert_batch(INDEX, documents)
            .expect("written")
            .failed
            .is_empty()
    );
    engine.close_index(INDEX).expect("closed");
    assert_eq!(
        state_of(&engine, INDEX),
        Some((IndexResidencyState::Closed, 500, 0))
    );
    for _ in 0..3 {
        let stats = engine
            .get_stats(INDEX)
            .expect("the stats of a closed index read");
        assert_eq!(
            (stats.document_count, stats.estimated_memory_bytes),
            (500, 0)
        );
        assert!(
            engine
                .get_partition_stats(INDEX)
                .expect("the partition stats read")
                .is_empty()
        );
    }
    assert_eq!(
        state_of(&engine, INDEX),
        Some((IndexResidencyState::Closed, 500, 0)),
        "reading the stats of a closed index left it closed"
    );
    std::thread::scope(|scope| {
        let callers: Vec<_> = (0..32)
            .map(|caller| {
                let engine = &engine;
                scope.spawn(move || match caller % 3 {
                    0 => engine.count_documents(INDEX).map(|count| count as usize),
                    1 => engine
                        .get(INDEX, "doc-7")
                        .map(|found| usize::from(found.is_some())),
                    _ => engine
                        .query(
                            INDEX,
                            &QueryParams {
                                term: Some("repair".into()),
                                limit: Some(1),
                                ..QueryParams::default()
                            },
                        )
                        .map(|result| result.count as usize),
                })
            })
            .collect();
        for (caller, handle) in callers.into_iter().enumerate() {
            let answer = handle
                .join()
                .expect("a caller returns")
                .expect("a caller succeeds");
            let wanted = match caller % 3 {
                1 => 1,
                _ => 500,
            };
            assert_eq!(answer, wanted, "caller {caller}");
        }
    });
    assert_eq!(
        state_of(&engine, INDEX),
        Some((IndexResidencyState::Open, 500, 1))
    );
    require_holds_exactly(&engine, INDEX, &written, "after the shared reopen");
}

#[test]
fn a_reopen_waiter_limit_of_zero_refuses_callers_that_find_a_reopen_running() {
    let root = ScratchDirectory::new("lifecycle-waiters");
    let lifecycle = IndexLifecycleConfig {
        max_reopen_waiters: Some(0),
        ..IndexLifecycleConfig::default()
    };
    let engine = Narsil::open(durable(root.path(), Some(lifecycle))).expect("the engine opens");
    engine.create_index(INDEX, index_config()).expect("created");
    let documents = (0..2_000).map(|n| ticket(&format!("doc-{n}"))).collect();
    assert!(
        engine
            .insert_batch(INDEX, documents)
            .expect("written")
            .failed
            .is_empty()
    );
    for _ in 0..5 {
        engine.close_index(INDEX).expect("closed");
        let outcomes: Vec<_> = std::thread::scope(|scope| {
            let callers: Vec<_> = (0..16)
                .map(|_| scope.spawn(|| engine.count_documents(INDEX)))
                .collect();
            callers
                .into_iter()
                .map(|caller| caller.join().expect("a caller returns"))
                .collect()
        });
        assert!(
            outcomes.iter().any(Result::is_ok),
            "no caller reopened the index"
        );
        for outcome in outcomes {
            match outcome {
                Ok(count) => assert_eq!(count, 2_000),
                Err(error) => {
                    assert_eq!(error.code(), ErrorCode::INDEX_REOPEN_CAPACITY_EXHAUSTED);
                    assert_eq!(
                        error.message(),
                        format!("Index \"{INDEX}\" has reached its reopen waiter limit of 0")
                    );
                }
            }
        }
    }
}

fn open_names(engine: &Narsil) -> Vec<String> {
    engine
        .list_indexes()
        .into_iter()
        .filter(|info| info.state == IndexResidencyState::Open)
        .map(|info| info.name)
        .collect()
}

#[test]
fn the_open_index_limit_closes_the_least_recently_used_index() {
    let root = ScratchDirectory::new("lifecycle-count");
    let lifecycle = IndexLifecycleConfig {
        max_open_indexes: Some(2),
        ..IndexLifecycleConfig::default()
    };
    let engine = Narsil::open(durable(root.path(), Some(lifecycle))).expect("the engine opens");
    let mut written = BTreeSet::new();
    for name in ["alpha", "bravo", "cedar"] {
        engine.create_index(name, index_config()).expect("created");
        let id = format!("{name}-1");
        engine
            .insert(name, ticket(&id), Some(&id))
            .expect("written");
        written.insert(id);
    }
    assert_eq!(open_names(&engine), vec!["bravo", "cedar"]);
    engine.get("alpha", "alpha-1").expect("alpha reopens");
    assert_eq!(open_names(&engine), vec!["alpha", "cedar"]);
    for name in ["alpha", "bravo", "cedar"] {
        let own: BTreeSet<String> = written
            .iter()
            .filter(|id| id.starts_with(name))
            .cloned()
            .collect();
        require_holds_exactly(
            &engine,
            name,
            &own,
            "after a close for the open index limit",
        );
        assert!(
            open_names(&engine).len() <= 2,
            "the engine holds more than two open indexes"
        );
    }
}

#[test]
fn the_idle_timeout_closes_an_unused_index_and_keeps_its_documents() {
    let root = ScratchDirectory::new("lifecycle-idle");
    let lifecycle = IndexLifecycleConfig {
        idle_timeout_ms: Some(150),
        ..IndexLifecycleConfig::default()
    };
    let engine = Narsil::open(durable(root.path(), Some(lifecycle))).expect("the engine opens");
    engine.create_index(INDEX, index_config()).expect("created");
    let written: BTreeSet<String> = (0..30).map(|n| format!("doc-{n}")).collect();
    for id in &written {
        engine.insert(INDEX, ticket(id), Some(id)).expect("written");
    }
    wait_for_state(&engine, INDEX, IndexResidencyState::Closed);
    require_holds_exactly(&engine, INDEX, &written, "after an idle close");
    wait_for_state(&engine, INDEX, IndexResidencyState::Closed);
    engine.shutdown().expect("the engine stops");
    let engine = Narsil::open(durable(root.path(), Some(lifecycle))).expect("the engine reopens");
    require_holds_exactly(&engine, INDEX, &written, "after a restart past idle closes");
}

#[test]
fn a_restart_with_lifecycle_limits_leaves_indexes_closed_until_a_call_reaches_them() {
    let root = ScratchDirectory::new("lifecycle-restart");
    let lifecycle = IndexLifecycleConfig {
        max_open_indexes: Some(8),
        ..IndexLifecycleConfig::default()
    };
    let written: BTreeSet<String> = (0..40).map(|n| format!("doc-{n}")).collect();
    {
        let engine = Narsil::open(durable(root.path(), Some(lifecycle))).expect("the engine opens");
        engine.create_index(INDEX, index_config()).expect("created");
        for id in &written {
            engine.insert(INDEX, ticket(id), Some(id)).expect("written");
        }
        engine.shutdown().expect("the engine stops");
    }
    let engine = Narsil::open(durable(root.path(), Some(lifecycle))).expect("the engine reopens");
    assert_eq!(
        state_of(&engine, INDEX).map(|(state, _, reopens)| (state, reopens)),
        Some((IndexResidencyState::Closed, 0))
    );
    let created = engine
        .create_index(INDEX, index_config())
        .expect_err("a closed index keeps its name");
    assert_eq!(created.code(), ErrorCode::INDEX_ALREADY_EXISTS);
    require_holds_exactly(&engine, INDEX, &written, "after the first call reopens it");
    assert_eq!(
        state_of(&engine, INDEX).map(|(state, _, _)| state),
        Some(IndexResidencyState::Open)
    );
}

#[test]
fn a_closed_index_drops_and_restores_like_an_open_one() {
    let root = ScratchDirectory::new("lifecycle-drop");
    let engine = Narsil::open(durable(root.path(), None)).expect("the engine opens");
    engine.create_index(INDEX, index_config()).expect("created");
    let written: BTreeSet<String> = (0..25).map(|n| format!("doc-{n}")).collect();
    for id in &written {
        engine.insert(INDEX, ticket(id), Some(id)).expect("written");
    }
    let mut snapshot = Vec::new();
    engine
        .snapshot(INDEX, &mut snapshot)
        .expect("the snapshot is written");
    engine.close_index(INDEX).expect("closed");
    engine.drop_index(INDEX).expect("a closed index drops");
    assert!(state_of(&engine, INDEX).is_none());
    let reached = engine
        .count_documents(INDEX)
        .expect_err("the dropped index is gone");
    assert_eq!(reached.code(), ErrorCode::INDEX_NOT_FOUND);
    engine.shutdown().expect("the engine stops");
    let engine = Narsil::open(durable(root.path(), None)).expect("the engine reopens");
    assert!(
        state_of(&engine, INDEX).is_none(),
        "the drop removed the files"
    );
    engine
        .create_index(INDEX, index_config())
        .expect("created again");
    engine.close_index(INDEX).expect("closed again");
    engine
        .restore(INDEX, &mut snapshot.as_slice())
        .expect("a restore replaces a closed index");
    require_holds_exactly(
        &engine,
        INDEX,
        &written,
        "after a restore over a closed index",
    );
    engine.shutdown().expect("the engine stops");
    let engine = Narsil::open(durable(root.path(), None)).expect("the engine reopens");
    require_holds_exactly(&engine, INDEX, &written, "after a restart past the restore");
}

#[test]
fn close_and_open_refuse_what_typescript_refuses() {
    let memory = Narsil::new();
    memory.create_index(INDEX, index_config()).expect("created");
    let refused = memory
        .close_index(INDEX)
        .expect_err("memory alone cannot close");
    assert_eq!(refused.code(), ErrorCode::CONFIG_INVALID);
    assert_eq!(
        refused.message(),
        "An index needs durability before it can close"
    );
    for outcome in [memory.close_index("missing"), memory.open_index("missing")] {
        let error = outcome.expect_err("a missing index is refused");
        assert_eq!(error.code(), ErrorCode::INDEX_NOT_FOUND);
        assert_eq!(error.message(), "Index \"missing\" does not exist");
    }
    memory
        .open_index(INDEX)
        .expect("an open index opens again without work");
    memory.shutdown().expect("the engine stops");
    let stopped = memory
        .close_index(INDEX)
        .expect_err("a stopped engine refuses");
    assert_eq!(stopped.code(), ErrorCode::INSTANCE_SHUT_DOWN);
}
