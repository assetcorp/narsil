mod support;

use std::ops::Range;
use std::path::Path;

use narsil::held_analysis::{HeldAnalysisChanges, PendingAnalysisChange};
use narsil::{
    DurabilityConfig, DurabilityMode, IndexConfig, Map, Narsil, NarsilConfig, QueryParams, Value,
    parse_json,
};
use support::ScratchDirectory;

const INDEX: &str = "notes";
const WORDS: [&str; 5] = ["alpha", "bravo", "cedar", "delta", "ember"];
const DROPPED: &str = "alpha";
const SEEDED_DOCUMENTS: u64 = 2_000;
const WRITTEN_WHILE_HELD: Range<u64> = 2_000..2_600;
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

fn dropping_alpha(generation: u64) -> PendingAnalysisChange {
    PendingAnalysisChange {
        generation,
        language: "english".to_string(),
        stop_word_list: Some(vec![DROPPED.to_string()]),
        ..PendingAnalysisChange::default()
    }
}

fn seeded(root: &Path) -> Narsil {
    let narsil = Narsil::open(wal_config(root)).expect("the engine opens");
    narsil
        .create_index(INDEX, index_config())
        .expect("the index is created");
    let written = narsil
        .insert_batch(INDEX, (0..SEEDED_DOCUMENTS).map(document_of).collect())
        .expect("the batch is written");
    assert!(
        written.failed.is_empty(),
        "the seed batch refused documents"
    );
    narsil
}

fn found(narsil: &Narsil, word: &str, versions: Range<u64>) -> Vec<String> {
    let mut ids = Vec::new();
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
    }
    ids.sort();
    ids
}

fn ids_with(versions: Range<u64>, word: &str) -> Vec<String> {
    let mut ids: Vec<String> = versions
        .filter(|version| title_of(*version).split(' ').any(|token| token == word))
        .map(|version| format!("doc-{version}"))
        .collect();
    ids.sort();
    ids
}

fn require_terms(narsil: &Narsil, versions: Range<u64>, alpha_dropped: bool, when: &str) {
    for word in WORDS {
        let wanted = if word == DROPPED && alpha_dropped {
            Vec::new()
        } else {
            ids_with(versions.clone(), word)
        };
        assert_eq!(
            found(narsil, word, versions.clone()),
            wanted,
            "the search for {word} {when}"
        );
    }
}

fn write_while_held(narsil: &Narsil) {
    for version in WRITTEN_WHILE_HELD {
        narsil
            .insert(INDEX, document_of(version), None)
            .expect("a write during the held change succeeds");
    }
}

#[test]
fn a_held_analysis_change_answers_under_the_old_terms_until_its_release_and_keeps_every_write() {
    let scratch = ScratchDirectory::new("held-analysis-release");
    let narsil = seeded(scratch.path());
    let held = HeldAnalysisChanges::new(&narsil);
    held.build_held_analysis(INDEX, &dropping_alpha(1))
        .expect("the held change builds its terms");
    assert!(held.held_analysis_is_built(INDEX, 1));
    held.build_held_analysis(INDEX, &dropping_alpha(1))
        .expect("a second call for the same change returns once it is built");
    write_while_held(&narsil);
    let every_version = 0..WRITTEN_WHILE_HELD.end;
    require_terms(
        &narsil,
        every_version.clone(),
        false,
        "while the change is held",
    );
    held.release_held_analysis(INDEX, 2)
        .expect("a release of another generation changes nothing");
    require_terms(
        &narsil,
        every_version.clone(),
        false,
        "after a release of another generation",
    );
    held.release_held_analysis(INDEX, 1)
        .expect("the release switches to the new terms");
    assert!(!held.held_analysis_is_built(INDEX, 1));
    require_terms(&narsil, every_version.clone(), true, "after the release");
    held.build_held_analysis(INDEX, &dropping_alpha(1))
        .expect("a change of a generation that the index holds returns at once");
    narsil.shutdown().expect("the engine shuts down");
    let reopened = Narsil::open(wal_config(scratch.path())).expect("the engine reopens");
    reopened
        .rebuild_analysis(INDEX)
        .expect("the reopened index finishes any change that it records");
    require_terms(&reopened, every_version, true, "after the restart");
}

#[test]
fn a_dropped_held_analysis_change_leaves_the_old_terms_and_no_pending_change_after_a_restart() {
    let scratch = ScratchDirectory::new("held-analysis-drop");
    let narsil = seeded(scratch.path());
    let held = HeldAnalysisChanges::new(&narsil);
    held.build_held_analysis(INDEX, &dropping_alpha(1))
        .expect("the held change builds its terms");
    write_while_held(&narsil);
    held.drop_held_analysis(INDEX)
        .expect("the held change is dropped");
    assert!(!held.held_analysis_is_built(INDEX, 1));
    let every_version = 0..WRITTEN_WHILE_HELD.end;
    require_terms(&narsil, every_version.clone(), false, "after the drop");
    held.release_held_analysis(INDEX, 1)
        .expect("a release after the drop changes nothing");
    require_terms(
        &narsil,
        every_version.clone(),
        false,
        "after a release of the dropped change",
    );
    narsil.shutdown().expect("the engine shuts down");
    let reopened = Narsil::open(wal_config(scratch.path())).expect("the engine reopens");
    reopened
        .rebuild_analysis(INDEX)
        .expect("the reopened index has no change to finish");
    require_terms(&reopened, every_version, false, "after the restart");
}
