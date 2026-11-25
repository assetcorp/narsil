mod support;

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};

use narsil::{
    AnalysisChange, AnalysisSetting, DurabilityConfig, DurabilityMode, Narsil, NarsilConfig,
};
use support::ScratchDirectory;
use support::folding::{
    WordDocument, YORUBA_WORDS, generated_documents, hit_ids, ids_with_word, insert_all,
    term_query, text_index, yoruba_fold,
};

const INDEX: &str = "words";
const CORPUS_SIZE: usize = 90;
const CORPUS_SEED: u64 = 23;
const QUERY: &str = "oko";
const BODY: &str = r#"{"body": "string"}"#;
const CHILD_DIRECTORY: &str = "NARSIL_FOLD_MARKS_CRASH_DIRECTORY";
const CRASH_ROUNDS: u64 = 6;
const CHECKPOINT_WRITES: u64 = 13;

fn wal_config(root: &Path) -> NarsilConfig {
    NarsilConfig {
        durability: Some(DurabilityConfig {
            directory: Some(root.to_path_buf()),
            mode: Some(DurabilityMode::Sync),
            checkpoint_mutation_threshold: Some(CHECKPOINT_WRITES),
            ..DurabilityConfig::default()
        }),
        ..NarsilConfig::default()
    }
}

fn corpus() -> Vec<WordDocument> {
    generated_documents(CORPUS_SIZE, &YORUBA_WORDS, CORPUS_SEED)
}

fn fold_marks(on: bool) -> AnalysisChange {
    AnalysisChange {
        fold_marks: AnalysisSetting::Set(on),
        ..AnalysisChange::default()
    }
}

fn tell_parent(line: &str) {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{line}").expect("the child writes");
    out.flush().expect("the child flushes");
}

#[test]
fn fold_marks_crash_child() {
    let Ok(directory) = std::env::var(CHILD_DIRECTORY) else {
        return;
    };
    let narsil = Narsil::open(wal_config(Path::new(&directory))).expect("the child opens");
    if narsil.count_documents(INDEX).is_err() {
        narsil
            .create_index(INDEX, text_index("yoruba", BODY))
            .expect("the child creates the index");
        insert_all(&narsil, INDEX, &corpus());
    }
    loop {
        for on in [false, true] {
            if narsil.change_analysis(INDEX, &fold_marks(on)).is_ok() {
                tell_parent("SWITCHED");
            }
        }
    }
}

fn killed_after(root: &Path, switches: u64) -> bool {
    let mut child = Command::new(std::env::current_exe().expect("the test binary has a path"))
        .args([
            "--exact",
            "fold_marks_crash_child",
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
        if line == "SWITCHED" {
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
fn a_kill_during_fold_marks_changes_reopens_under_one_setting() {
    let root = ScratchDirectory::new("fold-marks-crash");
    let documents = corpus();
    let folded = ids_with_word(&documents, |word| yoruba_fold(word) == QUERY);
    let written = ids_with_word(&documents, |word| word == QUERY);
    assert_ne!(folded, written, "the corpus tells the two settings apart");
    for round in 0..CRASH_ROUNDS {
        assert!(
            killed_after(root.path(), 1 + round % 3),
            "round {round} switched no setting"
        );
        let narsil = Narsil::open(wal_config(root.path()))
            .unwrap_or_else(|error| panic!("round {round} fails to recover: {error}"));
        narsil
            .rebuild_analysis(INDEX)
            .unwrap_or_else(|error| panic!("round {round} fails to finish the change: {error}"));
        assert_eq!(
            narsil.count_documents(INDEX).expect("the count reads"),
            documents.len() as u64,
            "round {round} lost documents"
        );
        let found = hit_ids(&narsil, INDEX, &term_query(QUERY));
        assert!(
            found == folded || found == written,
            "round {round} matched {found:?}, which is neither setting"
        );
        narsil.shutdown().expect("the parent shuts down");
    }
}
