mod support;

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use narsil::{
    DurabilityConfig, DurabilityMode, IndexConfig, Map, Narsil, NarsilConfig, QueryParams, Value,
};
use support::ScratchDirectory;

const INDEX: &str = "ledger";
const DOCUMENT_COUNT: u64 = 900;
const WORD_COUNT: u64 = 61;
const WORDS_PER_TITLE: u64 = 4;
const KEPT_STRIDE: u64 = 5;
const CONSONANTS: [char; 7] = ['b', 'd', 'g', 'm', 'n', 'r', 't'];
const VOWELS: [char; 3] = ['a', 'o', 'u'];

type Model = BTreeMap<String, Vec<String>>;

fn word(number: u64) -> String {
    let number = number as usize;
    let first = CONSONANTS[number % 7];
    let second = VOWELS[number % 3];
    let third = CONSONANTS[(number / 7) % 7];
    let fourth = VOWELS[(number / 21) % 3];
    format!("q{first}{second}{third}{fourth}k")
}

fn words_of(version: u64) -> Vec<String> {
    (0..WORDS_PER_TITLE)
        .map(|at| word((version * 13 + at * at * 7 + version / 3) % WORD_COUNT))
        .collect()
}

fn document_of(id: &str, version: u64) -> Map {
    let mut document = Map::new();
    document.insert("id", Value::String(id.to_string()));
    document.insert("title", Value::String(words_of(version).join(" ")));
    document
}

fn config(root: &Path) -> NarsilConfig {
    NarsilConfig {
        durability: Some(DurabilityConfig {
            directory: Some(root.to_path_buf()),
            mode: Some(DurabilityMode::Sync),
            ..DurabilityConfig::default()
        }),
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

fn insert_all(narsil: &Narsil, model: &mut Model, ids: &[String], version_shift: u64) {
    let documents: Vec<Map> = ids
        .iter()
        .enumerate()
        .map(|(at, id)| document_of(id, at as u64 + version_shift))
        .collect();
    let written = narsil
        .insert_batch(INDEX, documents)
        .expect("the batch inserts");
    assert_eq!(
        written.succeeded, ids,
        "every document of the batch inserts"
    );
    for (at, id) in ids.iter().enumerate() {
        model.insert(id.clone(), words_of(at as u64 + version_shift));
    }
}

fn require_agreement(narsil: &Narsil, model: &Model, moment: &str) {
    let count = narsil.count_documents(INDEX).expect("the count reads");
    assert_eq!(count, model.len() as u64, "the document count {moment}");
    for number in 0..WORD_COUNT {
        let sought = word(number);
        let query = QueryParams {
            term: Some(sought.clone()),
            exact: Some(true),
            limit: Some(10_000),
            ..QueryParams::default()
        };
        let found = narsil.query(INDEX, &query).expect("the search answers");
        let ids: BTreeSet<String> = found.hits.into_iter().map(|hit| hit.id).collect();
        let wanted: BTreeSet<String> = model
            .iter()
            .filter(|(_, words)| words.contains(&sought))
            .map(|(id, _)| id.clone())
            .collect();
        assert_eq!(ids, wanted, "the search for {sought} {moment}");
    }
}

fn remove_listed(narsil: &Narsil, model: &mut Model, listed: Vec<String>) {
    let mut expected_removed = Vec::new();
    let mut expected_refused = Vec::new();
    for id in &listed {
        if model.remove(id).is_some() {
            expected_removed.push(id.clone());
        } else {
            expected_refused.push(id.clone());
        }
    }
    let outcome = narsil
        .remove_batch(INDEX, listed)
        .expect("the batch removal answers");
    assert_eq!(
        outcome.succeeded, expected_removed,
        "the removal succeeds for each held document once"
    );
    let refused: Vec<String> = outcome
        .failed
        .into_iter()
        .map(|failure| failure.doc_id)
        .collect();
    assert_eq!(
        refused, expected_refused,
        "the removal refuses each missing, repeated, or empty ID"
    );
}

#[test]
fn a_batch_removal_leaves_every_search_as_single_removals_would() {
    let root = ScratchDirectory::new("batch-removal");
    let narsil = Narsil::open(config(root.path())).expect("the engine opens");
    narsil
        .create_index(INDEX, index_config())
        .expect("the index is created");
    let mut model = Model::new();
    let ids: Vec<String> = (0..DOCUMENT_COUNT)
        .map(|at| format!("entry-{at:04}"))
        .collect();
    insert_all(&narsil, &mut model, &ids, 0);
    require_agreement(&narsil, &model, "after the first inserts");

    let mut listed: Vec<String> = ids
        .iter()
        .enumerate()
        .filter(|(at, _)| *at as u64 % KEPT_STRIDE != 0)
        .map(|(_, id)| id.clone())
        .collect();
    listed.insert(3, "entry-never-written".to_string());
    listed.insert(40, listed[7].clone());
    listed.push(String::new());
    listed.push(listed[0].clone());
    remove_listed(&narsil, &mut model, listed);
    require_agreement(&narsil, &model, "after most documents leave in one batch");

    let returning: Vec<String> = ids
        .iter()
        .enumerate()
        .filter(|(at, _)| *at as u64 % KEPT_STRIDE == 2)
        .map(|(_, id)| id.clone())
        .collect();
    insert_all(&narsil, &mut model, &returning, 5_000);
    require_agreement(&narsil, &model, "after removed IDs return with other words");

    narsil.shutdown().expect("the engine shuts down");
    let narsil = Narsil::open(config(root.path())).expect("the engine reopens");
    require_agreement(&narsil, &model, "after the log replays");

    let held: Vec<String> = model.keys().cloned().collect();
    remove_listed(&narsil, &mut model, held);
    require_agreement(&narsil, &model, "after every document leaves");
    insert_all(&narsil, &mut model, &ids[..120], 9_000);
    require_agreement(&narsil, &model, "after writes follow an emptied index");

    narsil.shutdown().expect("the engine shuts down again");
    let narsil = Narsil::open(config(root.path())).expect("the engine reopens again");
    require_agreement(&narsil, &model, "after the second replay");
    narsil.shutdown().expect("the engine shuts down at the end");
}
