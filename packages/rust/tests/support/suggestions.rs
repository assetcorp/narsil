use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use narsil::{
    DurabilityConfig, IndexConfig, ListParams, Map, Narsil, NarsilConfig, NarsilEvent,
    NarsilEventKind, QuerySuggestionPreviewEntry, QuerySuggestionsConfig, QuerySuggestionsSetting,
    QuerySuggestionsWarningReason, RecordQueryOutcome, RecordedQuery, Value, parse_json,
    write_json,
};

use super::repository_root;

pub const INDEX: &str = "notes";
pub const KEY: &str = "narsil-suggestions-test-key-0123456789";
pub const OTHER_KEY: &str = "another-suggestions-test-key-9876543210";
pub const MIN_PEOPLE: u32 = 3;
pub const MIN_RESULTS: u32 = 2;
pub const GROUPS: [&str; 2] = ["web", "app"];
pub const VOCABULARY: [&str; 10] = [
    "amber", "copper", "falcon", "harbor", "lantern", "meadow", "orchid", "quartz", "saddle",
    "violet",
];
const CORPUS_DOCUMENTS: usize = 24;
const LISTING_PAGE: usize = 1_000;

pub fn engine_config(root: &Path, key: Option<&str>) -> NarsilConfig {
    NarsilConfig {
        durability: Some(DurabilityConfig {
            directory: Some(root.to_path_buf()),
            ..DurabilityConfig::default()
        }),
        query_suggestions: key.map(|key| QuerySuggestionsConfig {
            key: key.as_bytes().to_vec(),
        }),
        ..NarsilConfig::default()
    }
}

pub fn open(root: &Path, key: Option<&str>) -> Narsil {
    Narsil::open(engine_config(root, key)).expect("the engine opens its directory")
}

pub fn body_index() -> IndexConfig {
    let mut schema = Map::new();
    schema.insert("body", Value::String("string".into()));
    IndexConfig {
        schema: Value::Object(schema),
        ..IndexConfig::default()
    }
}

pub fn corpus() -> Vec<(String, Vec<&'static str>)> {
    (0..CORPUS_DOCUMENTS)
        .map(|document| {
            let words = VOCABULARY
                .iter()
                .enumerate()
                .filter(|(word, _)| (document * 3 + word * 5) % 7 < 3)
                .map(|(_, word)| *word)
                .collect();
            (format!("d{document}"), words)
        })
        .collect()
}

pub fn documents_of(corpus: &[(String, Vec<&str>)]) -> Vec<Map> {
    corpus
        .iter()
        .map(|(id, words)| {
            let mut document = Map::new();
            document.insert("id", Value::String(id.clone()));
            document.insert("body", Value::String(words.join(" ")));
            document
        })
        .collect()
}

pub fn create_with_corpus(narsil: &Narsil, index: &str, corpus: &[(String, Vec<&str>)]) {
    narsil
        .create_index(index, body_index())
        .expect("the index is created");
    let written = narsil
        .insert_batch(index, documents_of(corpus))
        .expect("the corpus is written");
    assert!(written.failed.is_empty(), "every document is written");
}

pub fn setting(min_people: u32, min_results: u32) -> QuerySuggestionsSetting {
    QuerySuggestionsSetting {
        enabled: true,
        fields: vec!["body".into()],
        min_people: Some(min_people),
        min_results: Some(min_results),
        result_checks_per_second: Some(1_000),
        schedule: Some("off".into()),
        ..QuerySuggestionsSetting::default()
    }
}

pub fn setting_json(min_people: u32, min_results: u32) -> Value {
    object(vec![
        ("enabled", Value::Bool(true)),
        ("fields", Value::Array(vec![Value::String("body".into())])),
        ("minPeople", Value::Number(f64::from(min_people))),
        ("minResults", Value::Number(f64::from(min_results))),
        ("resultChecksPerSecond", Value::Number(1_000.0)),
        ("schedule", Value::String("off".into())),
    ])
}

pub fn object(fields: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    for (key, value) in fields {
        map.insert(key, value);
    }
    Value::Object(map)
}

pub fn search(query: &str, person: &str, group: &str) -> RecordedQuery {
    RecordedQuery {
        query: query.into(),
        person: person.into(),
        group: group.into(),
    }
}

pub fn person(at: usize) -> String {
    format!("visitor-{at}@example.org")
}

pub fn candidate_phrases() -> Vec<String> {
    let mut phrases: Vec<String> = VOCABULARY.iter().map(|word| word.to_string()).collect();
    for (first, left) in VOCABULARY.iter().enumerate() {
        for right in &VOCABULARY[first + 1..] {
            phrases.push(format!("{left} {right}"));
        }
    }
    phrases
}

fn shouted(phrase: &str) -> String {
    format!("  {}  ", phrase.to_uppercase().replace(' ', " \t  "))
}

pub fn first_round() -> Vec<(RecordedQuery, RecordQueryOutcome)> {
    let mut searches = Vec::new();
    for (at, phrase) in candidate_phrases().iter().enumerate() {
        let group = GROUPS[at % GROUPS.len()];
        for visitor in 0..at % 5 {
            searches.push((
                search(phrase, &person(visitor), group),
                RecordQueryOutcome::Recorded,
            ));
        }
        if at % 5 > 0 {
            searches.push((
                search(&shouted(phrase), &person(0), group),
                RecordQueryOutcome::Repeat,
            ));
        }
    }
    for refused in ["abc", "amber 123456", "amber!"] {
        searches.push((
            search(refused, &person(0), "web"),
            RecordQueryOutcome::Invalid,
        ));
    }
    searches.push((
        search("amber", &person(0), "-web"),
        RecordQueryOutcome::Invalid,
    ));
    searches
}

pub fn second_round() -> Vec<(RecordedQuery, RecordQueryOutcome)> {
    let mut searches = Vec::new();
    for (at, phrase) in candidate_phrases().iter().enumerate() {
        if at % 3 != 0 {
            continue;
        }
        let group = GROUPS[at % GROUPS.len()];
        for visitor in 10..12 {
            searches.push((
                search(phrase, &person(visitor), group),
                RecordQueryOutcome::Recorded,
            ));
        }
    }
    searches
}

pub fn record_all(narsil: &Narsil, searches: &[(RecordedQuery, RecordQueryOutcome)]) {
    let suggestions = narsil.query_suggestions();
    for (query, expected) in searches {
        let result = suggestions
            .record_query(INDEX, query)
            .expect("the search is counted or refused");
        assert_eq!(result.outcome, *expected, "the outcome of {query:?}");
    }
}

pub fn normalised(text: &str) -> String {
    text.split_whitespace()
        .map(str::to_lowercase)
        .collect::<Vec<_>>()
        .join(" ")
}

pub type Counted = BTreeMap<(String, String), BTreeSet<String>>;

pub fn counted(rounds: &[&[(RecordedQuery, RecordQueryOutcome)]]) -> Counted {
    let mut people = Counted::new();
    for round in rounds {
        for (query, outcome) in round.iter() {
            if *outcome != RecordQueryOutcome::Recorded {
                continue;
            }
            people
                .entry((query.group.clone(), normalised(&query.query)))
                .or_default()
                .insert(query.person.clone());
        }
    }
    people
}

pub fn matching_documents(phrase: &str, corpus: &[(String, Vec<&str>)]) -> usize {
    corpus
        .iter()
        .filter(|(_, words)| phrase.split(' ').all(|word| words.contains(&word)))
        .count()
}

pub type Due = BTreeMap<String, BTreeMap<String, u64>>;

pub fn due(
    counted: &Counted,
    corpus: &[(String, Vec<&str>)],
    min_people: u32,
    min_results: u32,
) -> Due {
    let mut due = Due::new();
    for ((group, phrase), people) in counted {
        if people.len() >= min_people as usize
            && matching_documents(phrase, corpus) >= min_results as usize
        {
            due.entry(group.clone())
                .or_default()
                .insert(phrase.clone(), people.len() as u64);
        }
    }
    due
}

pub fn preview_order(due: &Due) -> Vec<(String, String, u64)> {
    let mut entries: Vec<(String, String, u64)> = due
        .iter()
        .flat_map(|(group, phrases)| {
            phrases
                .iter()
                .map(|(phrase, count)| (group.clone(), phrase.clone(), *count))
        })
        .collect();
    entries.sort_by(|left, right| {
        right
            .2
            .cmp(&left.2)
            .then_with(|| left.0.cmp(&right.0))
            .then_with(|| left.1.cmp(&right.1))
    });
    entries
}

pub fn preview_of(entries: &[QuerySuggestionPreviewEntry]) -> Vec<(String, String, u64)> {
    entries
        .iter()
        .map(|entry| (entry.group.clone(), entry.query.clone(), entry.count))
        .collect()
}

pub fn suggestions_of(
    narsil: &Narsil,
    index: &str,
    group: &str,
) -> BTreeMap<String, (u64, String)> {
    let name = narsil
        .query_suggestions()
        .suggestions_index_name(index, group)
        .expect("the group is valid");
    let mut held = BTreeMap::new();
    let mut cursor = None;
    loop {
        let page = match narsil.list_documents(
            &name,
            &ListParams {
                cursor,
                limit: Some(LISTING_PAGE),
                ..ListParams::default()
            },
        ) {
            Ok(page) => page,
            Err(error) if error.code() == narsil::ErrorCode::INDEX_NOT_FOUND => return held,
            Err(error) => panic!("the suggestions index lists: {error}"),
        };
        for listed in page.documents {
            held.insert(listed.id, suggestion_fields(&listed.document));
        }
        match page.cursor {
            Some(next) => cursor = Some(next),
            None => return held,
        }
    }
}

pub fn suggestion_fields(document: &Map) -> (u64, String) {
    let count = match document.get("count") {
        Some(Value::Number(count)) => *count as u64,
        other => panic!("a suggestion holds a numeric count, not {other:?}"),
    };
    let origin = match document.get("origin") {
        Some(Value::String(origin)) => origin.clone(),
        other => panic!("a suggestion holds an origin, not {other:?}"),
    };
    (count, origin)
}

pub fn popular(due: &Due, group: &str) -> BTreeMap<String, (u64, String)> {
    due.get(group)
        .map(|phrases| {
            phrases
                .iter()
                .map(|(phrase, count)| (phrase.clone(), (*count, "popular".to_string())))
                .collect()
        })
        .unwrap_or_default()
}

pub type Warnings = Arc<Mutex<Vec<(QuerySuggestionsWarningReason, Option<String>)>>>;

pub fn warnings_of(narsil: &Narsil) -> Warnings {
    let warnings: Warnings = Arc::default();
    let held = Arc::clone(&warnings);
    narsil.on(NarsilEventKind::QuerySuggestionsWarning, move |event| {
        if let NarsilEvent::QuerySuggestionsWarning { reason, file, .. } = event
            && let Ok(mut held) = held.lock()
        {
            held.push((*reason, file.clone()));
        }
    });
    warnings
}

pub fn taken(warnings: &Warnings) -> Vec<(QuerySuggestionsWarningReason, Option<String>)> {
    warnings
        .lock()
        .map(|mut held| std::mem::take(&mut *held))
        .unwrap_or_default()
}

pub fn files_under(directory: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let Ok(entries) = std::fs::read_dir(directory) else {
        return files;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            files.extend(files_under(&path));
        } else {
            files.push(path);
        }
    }
    files.sort();
    files
}

pub fn history_files(root: &Path, index: &str) -> Vec<PathBuf> {
    files_under(&root.join("_query-counts").join(index))
}

pub fn holds_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

pub fn reference(spec: Value, scratch: &Path) -> Map {
    let spec_path = scratch.join("suggestions-spec.json");
    std::fs::write(&spec_path, write_json(&spec)).expect("the spec is written");
    let script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/reference_query_suggestions.mjs");
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

pub fn killed_after(
    child_test: &str,
    variable: &str,
    root: &Path,
    acknowledgements: usize,
) -> Option<u64> {
    let mut child = Command::new(std::env::current_exe().expect("the test binary has a path"))
        .args(["--exact", child_test, "--nocapture", "--test-threads=1"])
        .env(variable, root)
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
