mod support;

use std::io::Cursor;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use narsil::held_analysis::HeldAnalysisChanges;
use narsil::{
    AnalysisChange, AnalysisSetting, DurabilityConfig, DurabilityMode, IndexConfig, Narsil,
    NarsilConfig, NarsilEventKind, PartitionConfig, SyncSetting, Value,
};
use support::ScratchDirectory;
use support::folding::{
    WordDocument, YORUBA_WORDS, generated_documents, hit_ids, ids_with_word, insert_all,
    term_query, text_index, yoruba_fold,
};

const INDEX: &str = "words";
const CORPUS_SIZE: usize = 90;
const CORPUS_SEED: u64 = 11;
const QUERY: &str = "oko";
const PARTITIONS: usize = 2;
const BODY: &str = r#"{"body": "string"}"#;

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

fn folded(documents: &[WordDocument]) -> Vec<String> {
    ids_with_word(documents, |word| yoruba_fold(word) == QUERY)
}

fn written(documents: &[WordDocument]) -> Vec<String> {
    ids_with_word(documents, |word| word == QUERY)
}

fn found(narsil: &Narsil) -> Vec<String> {
    hit_ids(narsil, INDEX, &term_query(QUERY))
}

fn fold_marks(setting: AnalysisSetting<bool>) -> AnalysisChange {
    AnalysisChange {
        fold_marks: setting,
        ..AnalysisChange::default()
    }
}

fn counted_rebuilds(narsil: &Narsil) -> Arc<AtomicUsize> {
    let rebuilds = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&rebuilds);
    narsil.on(NarsilEventKind::AnalysisRebuild, move |_| {
        counter.fetch_add(1, Ordering::SeqCst);
    });
    rebuilds
}

#[test]
fn fold_marks_switches_without_a_rebuild_and_restarts_keep_each_setting() {
    let scratch = ScratchDirectory::new("fold-marks-switch");
    let documents = generated_documents(CORPUS_SIZE, &YORUBA_WORDS, CORPUS_SEED);
    assert_ne!(written(&documents), folded(&documents));
    let mut engine = Narsil::open(wal_config(scratch.path())).expect("the engine opens");
    engine
        .create_index(
            INDEX,
            IndexConfig {
                partitions: Some(PartitionConfig {
                    max_partitions: Some(PARTITIONS as u64),
                    ..PartitionConfig::default()
                }),
                ..text_index("yoruba", BODY)
            },
        )
        .expect("the index is created");
    insert_all(&engine, INDEX, &documents);
    engine
        .rebalance(INDEX, PARTITIONS)
        .expect("the index spreads over two partitions");
    assert_eq!(found(&engine), folded(&documents));

    let rebuilds = counted_rebuilds(&engine);
    engine
        .change_analysis(INDEX, &fold_marks(AnalysisSetting::Set(false)))
        .expect("folding goes off");
    assert_eq!(found(&engine), written(&documents));
    engine
        .change_analysis(INDEX, &fold_marks(AnalysisSetting::Set(false)))
        .expect("the same setting again changes nothing");
    assert_eq!(rebuilds.load(Ordering::SeqCst), 0, "a fold change rebuilt");
    engine.shutdown().expect("the engine shuts down");

    engine = Narsil::open(wal_config(scratch.path())).expect("the engine reopens");
    assert_eq!(found(&engine), written(&documents));
    let rebuilds = counted_rebuilds(&engine);
    engine
        .change_analysis(INDEX, &fold_marks(AnalysisSetting::LanguageDefault))
        .expect("folding returns to the language's setting");
    assert_eq!(found(&engine), folded(&documents));
    assert_eq!(rebuilds.load(Ordering::SeqCst), 0, "a fold change rebuilt");
    let later = [
        WordDocument {
            id: "later-marked".into(),
            body: "ọkọ̀ ìwé".into(),
        },
        WordDocument {
            id: "later-plain".into(),
            body: "oko ile".into(),
        },
    ];
    insert_all(&engine, INDEX, &later);
    engine.shutdown().expect("the engine shuts down");

    engine = Narsil::open(wal_config(scratch.path())).expect("the engine reopens");
    let mut every = documents;
    every.extend(later);
    assert_eq!(found(&engine), folded(&every));
    engine.shutdown().expect("the engine shuts down");
}

#[test]
fn a_snapshot_carries_fold_marks_to_another_engine() {
    let scratch = ScratchDirectory::new("fold-marks-snapshot");
    let documents = generated_documents(CORPUS_SIZE, &YORUBA_WORDS, CORPUS_SEED);
    let engine = Narsil::open(wal_config(scratch.path())).expect("the engine opens");
    engine
        .create_index(
            INDEX,
            IndexConfig {
                fold_marks: Some(false),
                ..text_index("yoruba", BODY)
            },
        )
        .expect("the index is created");
    insert_all(&engine, INDEX, &documents);
    let mut archive = Vec::new();
    engine
        .snapshot(INDEX, &mut archive)
        .expect("the snapshot is written");
    let copy = Narsil::new();
    copy.restore(INDEX, &mut Cursor::new(&archive))
        .expect("the snapshot restores");
    assert_eq!(found(&copy), written(&documents));
    copy.change_analysis(INDEX, &fold_marks(AnalysisSetting::Set(true)))
        .expect("folding goes on in the copy");
    assert_eq!(found(&copy), folded(&documents));
    assert_eq!(found(&engine), written(&documents));
    engine.shutdown().expect("the engine shuts down");
}

#[test]
fn a_synced_index_sends_each_fold_marks_value_to_devices_under_one_epoch() {
    let scratch = ScratchDirectory::new("fold-marks-sync");
    let documents = generated_documents(CORPUS_SIZE, &YORUBA_WORDS, CORPUS_SEED);
    let engine = Narsil::open(wal_config(scratch.path())).expect("the engine opens");
    engine
        .create_index(INDEX, text_index("yoruba", BODY))
        .expect("the index is created");
    insert_all(&engine, INDEX, &documents);
    engine
        .update_sync(
            INDEX,
            &SyncSetting {
                enabled: true,
                ..SyncSetting::default()
            },
        )
        .expect("sync goes on");
    let state = || {
        engine
            .sync_feed_state(INDEX)
            .expect("the feed state reads")
            .expect("sync is on")
    };
    let first = state();
    assert_eq!(first.settings.get("foldMarks"), None);

    engine
        .change_analysis(INDEX, &fold_marks(AnalysisSetting::Set(false)))
        .expect("folding goes off");
    let off = state();
    assert_eq!(off.epoch, first.epoch, "a fold change drew a new epoch");
    assert_eq!(off.settings.get("foldMarks"), Some(&Value::Bool(false)));

    engine
        .change_analysis(INDEX, &fold_marks(AnalysisSetting::LanguageDefault))
        .expect("folding returns to the language's setting");
    let back = state();
    assert_eq!(back.epoch, first.epoch, "a fold change drew a new epoch");
    assert_eq!(back.settings.get("foldMarks"), None);
    engine.shutdown().expect("the engine shuts down");
}

#[test]
fn a_held_fold_change_waits_for_its_release_and_restarts_keep_it() {
    let scratch = ScratchDirectory::new("fold-marks-held");
    let documents = generated_documents(CORPUS_SIZE, &YORUBA_WORDS, CORPUS_SEED);
    let engine = Narsil::open(wal_config(scratch.path())).expect("the engine opens");
    let config = text_index("yoruba", BODY);
    engine
        .create_index(INDEX, config.clone())
        .expect("the index is created");
    insert_all(&engine, INDEX, &documents);
    let rebuilds = counted_rebuilds(&engine);
    let held = HeldAnalysisChanges::new(&engine);
    let mut pending = held
        .check_analysis_change(INDEX, &config, &fold_marks(AnalysisSetting::Set(false)))
        .expect("the change is valid");
    pending.generation = 1;
    held.build_held_analysis(INDEX, &pending)
        .expect("the held change is ready");
    assert!(held.held_analysis_is_built(INDEX, 1));
    assert_eq!(found(&engine), folded(&documents), "before the release");
    held.release_held_analysis(INDEX, 1)
        .expect("the release switches folding off");
    assert_eq!(found(&engine), written(&documents), "after the release");
    assert_eq!(held.analysis_generation(INDEX), Some(1));
    assert_eq!(rebuilds.load(Ordering::SeqCst), 0, "a fold change rebuilt");
    engine.shutdown().expect("the engine shuts down");

    let reopened = Narsil::open(wal_config(scratch.path())).expect("the engine reopens");
    reopened
        .rebuild_analysis(INDEX)
        .expect("the reopened index has no change to finish");
    assert_eq!(found(&reopened), written(&documents), "after the restart");
    assert_eq!(
        HeldAnalysisChanges::new(&reopened).analysis_generation(INDEX),
        Some(1)
    );
    reopened.shutdown().expect("the engine shuts down");
}
