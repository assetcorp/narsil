mod support;

use std::collections::HashSet;
use std::io::{BufRead, BufReader, Write};
use std::ops::Range;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use narsil::{
    AnalysisChange, AnalysisSetting, DurabilityConfig, DurabilityMode, DurabilityTier, ErrorCode,
    IndexConfig, Map, MemoryPersistence, Narsil, NarsilConfig, NarsilEvent, NarsilEventKind,
    QueryParams, StopWords, StopWordsSetting, Value, WorkStatus, parse_json,
};
use support::ScratchDirectory;

const INDEX: &str = "notes";
const WORDS: [&str; 5] = ["alpha", "bravo", "cedar", "delta", "ember"];
const DROPPED: &str = "alpha";
const CHILD_DIRECTORY: &str = "NARSIL_ANALYSIS_CRASH_DIRECTORY";
const CRASH_DOCUMENTS: u64 = 4_000;
const MAX_HITS_PER_SEARCH: u64 = 10_000;

fn title_of(version: u64) -> String {
    let first = WORDS[(version % 5) as usize];
    let second = WORDS[((version / 5) % 5) as usize];
    format!("{first} {second} note")
}

fn document_of(version: u64) -> Map {
    let mut document = Map::new();
    document.insert("id", Value::String(format!("doc-{version}")));
    document.insert("title", Value::String(title_of(version)));
    document.insert("version", Value::Number(version as f64));
    document
}

fn index_config() -> IndexConfig {
    let mut schema = Map::new();
    schema.insert("title", Value::String("string".into()));
    schema.insert("version", Value::String("number".into()));
    IndexConfig {
        schema: Value::Object(schema),
        ..IndexConfig::default()
    }
}

fn wal_config(root: &Path) -> NarsilConfig {
    NarsilConfig {
        durability: Some(DurabilityConfig {
            directory: Some(root.to_path_buf()),
            mode: Some(DurabilityMode::Sync),
            ..DurabilityConfig::default()
        }),
        ..NarsilConfig::default()
    }
}

fn snapshot_config(adapter: Arc<MemoryPersistence>) -> NarsilConfig {
    NarsilConfig {
        durability: Some(DurabilityConfig {
            tier: Some(DurabilityTier::Snapshot),
            ..DurabilityConfig::default()
        }),
        persistence: Some(adapter),
        ..NarsilConfig::default()
    }
}

fn dropping_alpha() -> AnalysisChange {
    AnalysisChange {
        stop_words: AnalysisSetting::Set(StopWordsSetting::Words(StopWords::Set(
            [DROPPED.to_string()].into_iter().collect(),
        ))),
        ..AnalysisChange::default()
    }
}

fn language_stop_words() -> AnalysisChange {
    AnalysisChange {
        stop_words: AnalysisSetting::LanguageDefault,
        ..AnalysisChange::default()
    }
}

fn seed(narsil: &Narsil, count: u64) {
    narsil
        .create_index(INDEX, index_config())
        .expect("the index is created");
    let written = narsil
        .insert_batch(INDEX, (0..count).map(document_of).collect())
        .expect("the batch is written");
    assert!(
        written.failed.is_empty(),
        "the seed batch refused documents"
    );
}

fn found(narsil: &Narsil, word: &str, versions: Range<u64>) -> (Vec<String>, bool) {
    let mut ids = Vec::new();
    let mut stale = false;
    for first in versions.clone().step_by(MAX_HITS_PER_SEARCH as usize) {
        let end = (first + MAX_HITS_PER_SEARCH).min(versions.end);
        let query = QueryParams {
            term: Some(word.to_string()),
            filters: Some(
                parse_json(&format!(
                    r#"{{"fields": {{"version": {{"gte": {first}, "lt": {end}}}}}}}"#
                ))
                .expect("the filter is JSON"),
            ),
            limit: Some(MAX_HITS_PER_SEARCH as usize),
            ..QueryParams::default()
        };
        let result = narsil.query(INDEX, &query).expect("the search answers");
        ids.extend(result.hits.into_iter().map(|hit| hit.id));
        stale |= result.analysis_stale;
    }
    ids.sort();
    (ids, stale)
}

fn every_version(versions: &[u64]) -> Range<u64> {
    0..versions.iter().max().map_or(0, |last| last + 1)
}

fn ids_with(versions: &[u64], word: &str) -> Vec<String> {
    let mut ids: Vec<String> = versions
        .iter()
        .filter(|version| title_of(**version).split(' ').any(|token| token == word))
        .map(|version| format!("doc-{version}"))
        .collect();
    ids.sort();
    ids
}

fn require_terms(narsil: &Narsil, versions: &[u64], alpha_dropped: bool, when: &str) {
    for word in WORDS {
        let (ids, stale) = found(narsil, word, every_version(versions));
        let wanted = if word == DROPPED && alpha_dropped {
            Vec::new()
        } else {
            ids_with(versions, word)
        };
        assert_eq!(ids, wanted, "the search for {word} {when}");
        assert!(!stale, "the search for {word} reports stale terms {when}");
    }
}

fn require_refused(narsil: &Narsil, change: AnalysisChange, code: ErrorCode, what: &str) {
    match narsil.change_analysis(INDEX, &change) {
        Err(error) => assert_eq!(error.code(), code, "{what}: {}", error.message()),
        Ok(()) => panic!("{what} was accepted"),
    }
}

fn require_bad_changes_refused(narsil: &Narsil, versions: &[u64]) {
    require_refused(
        narsil,
        AnalysisChange {
            language: Some("klingon".into()),
            ..AnalysisChange::default()
        },
        ErrorCode::LANGUAGE_NOT_SUPPORTED,
        "an unknown language",
    );
    require_refused(
        narsil,
        AnalysisChange {
            stop_words: AnalysisSetting::Set(StopWordsSetting::Named("unregistered".into())),
            ..AnalysisChange::default()
        },
        ErrorCode::CONFIG_INVALID,
        "an unregistered stop word set",
    );
    require_refused(
        narsil,
        AnalysisChange {
            tokenizer: AnalysisSetting::Set("unregistered".into()),
            ..AnalysisChange::default()
        },
        ErrorCode::CONFIG_INVALID,
        "an unregistered tokenizer",
    );
    let function: narsil::StopWordFunction = Arc::new(|words: &HashSet<String>| words.clone());
    require_refused(
        narsil,
        AnalysisChange {
            stop_words: AnalysisSetting::Set(StopWordsSetting::Words(StopWords::Function(
                function,
            ))),
            ..AnalysisChange::default()
        },
        ErrorCode::CONFIG_INVALID,
        "a stop word function",
    );
    assert!(
        narsil.change_analysis("absent", &dropping_alpha()).is_err(),
        "a change of an absent index was accepted"
    );
    require_terms(narsil, versions, false, "after the refused changes");
}

fn change_holds_across_restarts(config: NarsilConfig, checkpoints: bool) {
    let narsil = Narsil::open(config.clone()).expect("the engine opens");
    seed(&narsil, 300);
    let mut versions: Vec<u64> = (0..300).collect();
    let statuses = Arc::new(Mutex::new(Vec::new()));
    let heard = Arc::clone(&statuses);
    narsil.on(NarsilEventKind::AnalysisRebuild, move |event| {
        if let NarsilEvent::AnalysisRebuild { status, .. } = event {
            heard.lock().expect("the log locks").push(*status);
        }
    });
    require_bad_changes_refused(&narsil, &versions);
    narsil
        .change_analysis(INDEX, &dropping_alpha())
        .expect("the stop word change succeeds");
    require_terms(&narsil, &versions, true, "after the change");
    assert_eq!(
        *statuses.lock().expect("the log locks"),
        vec![WorkStatus::Started, WorkStatus::Completed]
    );
    narsil
        .change_analysis(INDEX, &dropping_alpha())
        .expect("a change to the held settings succeeds");
    assert_eq!(
        statuses.lock().expect("the log locks").len(),
        2,
        "a no-op change rebuilt the terms"
    );
    narsil
        .insert(INDEX, document_of(300), None)
        .expect("a write under the new settings succeeds");
    versions.push(300);
    if checkpoints {
        narsil.checkpoint(INDEX).expect("the checkpoint is written");
    }
    narsil.shutdown().expect("the engine shuts down");
    let reopened = Narsil::open(config.clone()).expect("the engine reopens");
    require_terms(&reopened, &versions, true, "after the restart");
    reopened
        .change_analysis(INDEX, &language_stop_words())
        .expect("the return to the language's stop words succeeds");
    require_terms(&reopened, &versions, false, "after the return");
    if checkpoints {
        reopened
            .checkpoint(INDEX)
            .expect("the checkpoint is written");
    }
    reopened.shutdown().expect("the engine shuts down");
    let again = Narsil::open(config).expect("the engine reopens again");
    require_terms(&again, &versions, false, "after the second restart");
}

const STOP_WORD_DIGITS: usize = 200;
const FITTING_STOP_WORDS: usize = 70_000;
const OVERSIZED_STOP_WORDS: usize = 90_000;

fn stop_word_set(count: usize) -> StopWordsSetting {
    StopWordsSetting::Words(StopWords::Set(
        (0..count)
            .map(|at| format!("{at:0STOP_WORD_DIGITS$}"))
            .collect(),
    ))
}

#[test]
fn a_configuration_past_sixteen_mebibytes_is_refused_at_creation_and_on_an_analysis_change() {
    let narsil = Narsil::new();
    let oversized = IndexConfig {
        stop_words: Some(stop_word_set(OVERSIZED_STOP_WORDS)),
        ..index_config()
    };
    let refused = narsil
        .create_index(INDEX, oversized)
        .expect_err("an oversized configuration is refused");
    assert_eq!(refused.code(), ErrorCode::CONFIG_INVALID);
    assert!(narsil.list_indexes().is_empty());

    let fitting = IndexConfig {
        stop_words: Some(stop_word_set(FITTING_STOP_WORDS)),
        ..index_config()
    };
    narsil
        .create_index(INDEX, fitting)
        .expect("a configuration within the limit is created");
    narsil
        .insert(INDEX, document_of(0), None)
        .expect("the document is written");
    let refused = narsil
        .change_analysis(
            INDEX,
            &AnalysisChange {
                language: None,
                tokenizer: AnalysisSetting::Keep,
                stop_words: AnalysisSetting::Set(stop_word_set(OVERSIZED_STOP_WORDS)),
            },
        )
        .expect_err("an analysis change past the limit is refused");
    assert_eq!(refused.code(), ErrorCode::CONFIG_INVALID);
    assert_eq!(narsil.count_documents(INDEX).expect("the count reads"), 1);
}

#[test]
fn an_analysis_change_holds_after_restarts_under_the_write_ahead_log() {
    let root = ScratchDirectory::new("analysis-wal");
    change_holds_across_restarts(wal_config(root.path()), false);
}

#[test]
fn an_analysis_change_holds_after_restarts_under_snapshots() {
    change_holds_across_restarts(snapshot_config(Arc::new(MemoryPersistence::new())), true);
}

#[test]
fn writes_during_an_analysis_change_reach_the_new_terms() {
    let root = ScratchDirectory::new("analysis-writes");
    let narsil = Arc::new(Narsil::open(wal_config(root.path())).expect("the engine opens"));
    let seeded = 3_000;
    seed(&narsil, seeded);
    let done = Arc::new(AtomicBool::new(false));
    let writer = {
        let narsil = Arc::clone(&narsil);
        let done = Arc::clone(&done);
        std::thread::spawn(move || {
            let mut version = seeded;
            while !done.load(Ordering::SeqCst) {
                narsil
                    .insert(INDEX, document_of(version), None)
                    .expect("a write during the change succeeds");
                version += 1;
            }
            version
        })
    };
    let searcher = {
        let narsil = Arc::clone(&narsil);
        let done = Arc::clone(&done);
        std::thread::spawn(move || {
            let mut mixed = 0u64;
            while !done.load(Ordering::SeqCst) {
                let (ids, _) = found(&narsil, DROPPED, 0..seeded);
                let seen: HashSet<&String> = ids.iter().collect();
                let seeded_alpha = ids_with(&(0..seeded).collect::<Vec<_>>(), DROPPED);
                let held = seeded_alpha.iter().filter(|id| seen.contains(id)).count();
                if held != 0 && held != seeded_alpha.len() {
                    mixed += 1;
                }
            }
            mixed
        })
    };
    for change in [dropping_alpha(), language_stop_words(), dropping_alpha()] {
        narsil
            .change_analysis(INDEX, &change)
            .expect("the change succeeds");
    }
    done.store(true, Ordering::SeqCst);
    let last = writer.join().expect("the writer finishes");
    let mixed = searcher.join().expect("the searcher finishes");
    assert_eq!(
        mixed, 0,
        "a search matched under a mix of the old and new settings"
    );
    assert!(last > seeded, "no write ran during the change");
    let versions: Vec<u64> = (0..last).collect();
    require_terms(&narsil, &versions, true, "after the change");
    narsil.shutdown().expect("the engine shuts down");
    let reopened = Narsil::open(wal_config(root.path())).expect("the engine reopens");
    require_terms(&reopened, &versions, true, "after the restart");
}

#[test]
fn analysis_crash_child() {
    let Ok(directory) = std::env::var(CHILD_DIRECTORY) else {
        return;
    };
    let narsil = Narsil::open_with(wal_config(Path::new(&directory)), |engine| {
        engine.on(NarsilEventKind::AnalysisRebuild, |event| {
            if let NarsilEvent::AnalysisRebuild {
                status: WorkStatus::Started,
                ..
            } = event
            {
                tell_parent("STARTED");
            }
        });
        Ok(())
    })
    .expect("the child opens");
    if narsil.count_documents(INDEX).is_err() {
        seed(&narsil, CRASH_DOCUMENTS);
    }
    tell_parent("READY");
    loop {
        for change in [dropping_alpha(), language_stop_words()] {
            let _ = narsil.change_analysis(INDEX, &change);
        }
    }
}

fn tell_parent(line: &str) {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{line}").expect("the child writes");
    out.flush().expect("the child flushes");
}

fn killed_after(root: &Path, switches: u64) -> bool {
    let mut child = Command::new(std::env::current_exe().expect("the test binary has a path"))
        .args([
            "--exact",
            "analysis_crash_child",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD_DIRECTORY, root)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("the child starts");
    let stdout = child.stdout.take().expect("the child's output is piped");
    let mut seen = 0;
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        if line == "STARTED" {
            seen += 1;
            if seen >= switches {
                break;
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    seen > 0
}

#[test]
fn a_kill_during_analysis_changes_reopens_under_one_set_of_settings() {
    let root = ScratchDirectory::new("analysis-crash");
    let versions: Vec<u64> = (0..CRASH_DOCUMENTS).collect();
    let all_alpha = ids_with(&versions, DROPPED);
    let resumed = Arc::new(Mutex::new(0u64));
    for round in 0..6 {
        if !killed_after(root.path(), 1 + round % 3) {
            panic!("round {round} started no change");
        }
        let heard = Arc::clone(&resumed);
        let narsil = Narsil::open_with(wal_config(root.path()), move |engine| {
            engine.on(NarsilEventKind::AnalysisRebuild, move |event| {
                if let NarsilEvent::AnalysisRebuild {
                    status: WorkStatus::Completed,
                    ..
                } = event
                {
                    *heard.lock().expect("the count locks") += 1;
                }
            });
            Ok(())
        })
        .unwrap_or_else(|error| panic!("round {round} fails to recover: {error}"));
        narsil
            .rebuild_analysis(INDEX)
            .unwrap_or_else(|error| panic!("round {round} fails to finish the change: {error}"));
        assert_eq!(
            narsil.count_documents(INDEX).expect("the count reads"),
            CRASH_DOCUMENTS,
            "round {round} lost documents"
        );
        let (alpha, stale) = found(&narsil, DROPPED, every_version(&versions));
        assert!(
            !stale,
            "round {round} reports stale terms after the rebuild"
        );
        let dropped = alpha.is_empty();
        assert!(
            dropped || alpha == all_alpha,
            "round {round} matched {} of {} alpha documents, a mix of two settings",
            alpha.len(),
            all_alpha.len()
        );
        require_terms(
            &narsil,
            &versions,
            dropped,
            &format!("after crash round {round}"),
        );
        narsil.shutdown().expect("the parent shuts down");
    }
    assert!(
        *resumed.lock().expect("the count locks") > 0,
        "no round killed a change in flight, so no restart finished one"
    );
}
