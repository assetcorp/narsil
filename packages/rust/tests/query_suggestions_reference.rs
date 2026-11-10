mod support;

use std::collections::BTreeMap;
use std::path::Path;

use narsil::{
    Map, QuerySuggestionsBuildStatus, RecordQueryOutcome, RecordedQuery, SnapshotOptions, Value,
};
use support::ScratchDirectory;
use support::suggestions::{
    Due, GROUPS, INDEX, KEY, MIN_PEOPLE, MIN_RESULTS, OTHER_KEY, corpus, counted,
    create_with_corpus, documents_of, due, first_round, history_files, object, open, popular,
    preview_of, preview_order, record_all, reference, second_round, setting, setting_json,
    suggestion_fields, suggestions_of, taken, warnings_of,
};

const COPY: &str = "copy";
const PLAIN: &str = "plain";

fn text(value: &str) -> Value {
    Value::String(value.into())
}

fn step(op: &str, index: &str, fields: Vec<(&str, Value)>) -> Value {
    let mut all = vec![("op", text(op)), ("index", text(index))];
    all.extend(fields);
    object(all)
}

fn queries_json(searches: &[(RecordedQuery, RecordQueryOutcome)]) -> Value {
    Value::Array(
        searches
            .iter()
            .map(|(query, _)| {
                object(vec![
                    ("query", text(&query.query)),
                    ("person", text(&query.person)),
                    ("group", text(&query.group)),
                ])
            })
            .collect(),
    )
}

fn spec(directory: &Path, key: Option<&str>, steps: Vec<Value>) -> Value {
    let mut fields = vec![
        ("directory", text(&directory.to_string_lossy())),
        ("steps", Value::Array(steps)),
    ];
    if let Some(key) = key {
        fields.push(("key", text(key)));
    }
    object(fields)
}

fn results_of(outcome: &Map) -> Vec<Map> {
    match outcome.get("results") {
        Some(Value::Array(results)) => results
            .iter()
            .map(|result| match result {
                Value::Object(result) => result.clone(),
                other => panic!("a step result is an object, not {other:?}"),
            })
            .collect(),
        other => panic!("the reference lists its results, not {other:?}"),
    }
}

fn warning_reasons(outcome: &Map) -> Vec<String> {
    match outcome.get("warnings") {
        Some(Value::Array(warnings)) => warnings
            .iter()
            .filter_map(|warning| match warning {
                Value::Object(warning) => match warning.get("reason") {
                    Some(Value::String(reason)) => Some(reason.clone()),
                    _ => None,
                },
                _ => None,
            })
            .collect(),
        other => panic!("the reference lists its warnings, not {other:?}"),
    }
}

fn succeeded(result: &Map) {
    assert!(
        result.get("error").is_none(),
        "the reference step failed: {:?}",
        result.get("error")
    );
}

fn field_text(result: &Map, name: &str) -> String {
    match result.get(name) {
        Some(Value::String(value)) => value.clone(),
        other => panic!("the result holds {name}, not {other:?}"),
    }
}

fn number(value: Option<&Value>) -> u64 {
    match value {
        Some(Value::Number(value)) => *value as u64,
        other => panic!("a count is a number, not {other:?}"),
    }
}

fn reference_preview(result: &Map) -> Vec<(String, String, u64)> {
    succeeded(result);
    let Some(Value::Array(entries)) = result.get("entries") else {
        panic!("the preview lists its entries");
    };
    entries
        .iter()
        .map(|entry| match entry {
            Value::Object(entry) => (
                field_text(entry, "group"),
                field_text(entry, "query"),
                number(entry.get("count")),
            ),
            other => panic!("a preview entry is an object, not {other:?}"),
        })
        .collect()
}

fn reference_documents(result: &Map) -> BTreeMap<String, (u64, String)> {
    succeeded(result);
    let Some(Value::Array(documents)) = result.get("documents") else {
        panic!("the reference lists the documents");
    };
    documents
        .iter()
        .map(|document| match document {
            Value::Object(document) => (field_text(document, "id"), suggestion_fields(document)),
            other => panic!("a document is an object, not {other:?}"),
        })
        .collect()
}

fn reference_outcomes(result: &Map) -> Vec<String> {
    succeeded(result);
    let Some(Value::Array(outcomes)) = result.get("outcomes") else {
        panic!("the reference lists its outcomes");
    };
    outcomes
        .iter()
        .map(|outcome| match outcome {
            Value::String(outcome) => outcome.clone(),
            other => panic!("an outcome is text, not {other:?}"),
        })
        .collect()
}

fn expected_outcomes(searches: &[(RecordedQuery, RecordQueryOutcome)]) -> Vec<String> {
    searches
        .iter()
        .map(|(_, outcome)| outcome.as_str().to_string())
        .collect()
}

fn listed_preview(narsil: &narsil::Narsil, index: &str) -> Vec<(String, String, u64)> {
    let preview = narsil
        .query_suggestions()
        .preview(index, Some(1_000))
        .expect("the preview reads");
    preview_of(&preview.entries)
}

fn documents_step(index: &str, group: &str) -> Value {
    step(
        "documents",
        &format!("{index}.suggestions.{group}"),
        Vec::new(),
    )
}

fn oracle_first() -> Due {
    let once = due(
        &counted(&[&first_round()]),
        &corpus(),
        MIN_PEOPLE,
        MIN_RESULTS,
    );
    assert!(
        GROUPS.iter().all(|group| !popular(&once, group).is_empty()),
        "the oracle publishes phrases in every group"
    );
    once
}

#[test]
fn typescript_and_the_crate_read_each_other_s_history_and_suggestions() {
    let scratch = ScratchDirectory::new("suggestions-cross");
    let root = scratch.path().join("engine");
    let corpus = corpus();
    let first = first_round();
    let second = second_round();
    let narsil = open(&root, Some(KEY));
    create_with_corpus(&narsil, INDEX, &corpus);
    narsil
        .query_suggestions()
        .update_setting(INDEX, &setting(MIN_PEOPLE, MIN_RESULTS))
        .expect("the feature turns on");
    record_all(&narsil, &first);
    narsil.shutdown().expect("the engine shuts down");

    let once = oracle_first();
    let outcome = reference(
        spec(
            &root,
            Some(KEY),
            vec![
                step("preview", INDEX, vec![("limit", Value::Number(1_000.0))]),
                step("build", INDEX, Vec::new()),
                documents_step(INDEX, GROUPS[0]),
                documents_step(INDEX, GROUPS[1]),
                step("record", INDEX, vec![("queries", queries_json(&second))]),
            ],
        ),
        scratch.path(),
    );
    assert!(
        warning_reasons(&outcome).is_empty(),
        "{:?}",
        warning_reasons(&outcome)
    );
    let results = results_of(&outcome);
    assert_eq!(
        reference_preview(&results[0]),
        preview_order(&once),
        "TypeScript counts the crate's history as the oracle does"
    );
    succeeded(&results[1]);
    assert_eq!(field_text(&results[1], "status"), "completed");
    for (at, group) in GROUPS.iter().enumerate() {
        assert_eq!(reference_documents(&results[2 + at]), popular(&once, group));
    }
    assert_eq!(reference_outcomes(&results[4]), expected_outcomes(&second));

    let both = due(
        &counted(&[&first, &second]),
        &corpus,
        MIN_PEOPLE,
        MIN_RESULTS,
    );
    let narsil = open(&root, Some(KEY));
    let warnings = warnings_of(&narsil);
    for group in GROUPS {
        assert_eq!(
            suggestions_of(&narsil, INDEX, group),
            popular(&once, group),
            "the crate reads the suggestions index that TypeScript built for {group}"
        );
    }
    let status = narsil
        .query_suggestions()
        .status(INDEX)
        .expect("the status reads");
    for group in GROUPS {
        let name = format!("{INDEX}.suggestions.{group}");
        assert!(
            status.suggestion_indexes.contains(&name),
            "{name} carries its marker"
        );
    }
    assert_eq!(listed_preview(&narsil, INDEX), preview_order(&both));
    let build = narsil
        .query_suggestions()
        .build(INDEX)
        .expect("the build runs");
    assert_eq!(build.status, QuerySuggestionsBuildStatus::Completed);
    for group in GROUPS {
        assert_eq!(suggestions_of(&narsil, INDEX, group), popular(&both, group));
    }
    assert!(taken(&warnings).is_empty());
    narsil.shutdown().expect("the engine shuts down");

    let other = reference(
        spec(
            &root,
            Some(OTHER_KEY),
            vec![step(
                "preview",
                INDEX,
                vec![("limit", Value::Number(1_000.0))],
            )],
        ),
        scratch.path(),
    );
    assert!(
        reference_preview(&results_of(&other)[0]).is_empty(),
        "another key reads no count of the crate's history"
    );
    assert!(
        warning_reasons(&other)
            .iter()
            .any(|reason| reason == "other-key")
    );
}

fn snapshot_of(narsil: &narsil::Narsil, query_history: bool) -> Vec<u8> {
    let mut bytes = Vec::new();
    narsil
        .snapshot_with(INDEX, &mut bytes, &SnapshotOptions { query_history })
        .expect("the snapshot is written");
    bytes
}

#[test]
fn a_snapshot_with_history_restores_into_the_other_implementation() {
    let scratch = ScratchDirectory::new("suggestions-snapshots");
    let corpus = corpus();
    let once = oracle_first();
    let source = scratch.path().join("crate-source");
    let narsil = open(&source, Some(KEY));
    create_with_corpus(&narsil, INDEX, &corpus);
    narsil
        .query_suggestions()
        .update_setting(INDEX, &setting(MIN_PEOPLE, MIN_RESULTS))
        .expect("the feature turns on");
    record_all(&narsil, &first_round());
    let with_history = scratch.path().join("crate-history.snapshot");
    let without_history = scratch.path().join("crate-plain.snapshot");
    std::fs::write(&with_history, snapshot_of(&narsil, true)).expect("the snapshot is saved");
    std::fs::write(&without_history, snapshot_of(&narsil, false)).expect("the snapshot is saved");
    narsil.shutdown().expect("the engine shuts down");

    let keyed = scratch.path().join("reference-keyed");
    let outcome = reference(
        spec(
            &keyed,
            Some(KEY),
            vec![
                step(
                    "restore",
                    COPY,
                    vec![("path", text(&with_history.to_string_lossy()))],
                ),
                step("preview", COPY, vec![("limit", Value::Number(1_000.0))]),
                step(
                    "restore",
                    PLAIN,
                    vec![("path", text(&without_history.to_string_lossy()))],
                ),
                step("preview", PLAIN, vec![("limit", Value::Number(1_000.0))]),
            ],
        ),
        scratch.path(),
    );
    let results = results_of(&outcome);
    succeeded(&results[0]);
    assert_eq!(
        reference_preview(&results[1]),
        preview_order(&once),
        "TypeScript restores the history that the crate's snapshot carries"
    );
    succeeded(&results[2]);
    assert!(reference_preview(&results[3]).is_empty());
    assert!(
        history_files(&keyed, PLAIN).is_empty(),
        "a snapshot without history stores none"
    );
    assert!(
        warning_reasons(&outcome).is_empty(),
        "{:?}",
        warning_reasons(&outcome)
    );

    let keyless = scratch.path().join("reference-keyless");
    reference(
        spec(
            &keyless,
            None,
            vec![step(
                "restore",
                COPY,
                vec![("path", text(&with_history.to_string_lossy()))],
            )],
        ),
        scratch.path(),
    );
    assert!(
        history_files(&keyless, COPY).is_empty(),
        "an engine without a key stores no restored search"
    );

    let reference_source = scratch.path().join("reference-source");
    let reference_history = scratch.path().join("reference-history.snapshot");
    let documents = Value::Array(
        documents_of(&corpus)
            .into_iter()
            .map(Value::Object)
            .collect(),
    );
    let mut schema = Map::new();
    schema.insert("body", text("string"));
    let made = reference(
        spec(
            &reference_source,
            Some(KEY),
            vec![
                step("create", INDEX, vec![("schema", Value::Object(schema))]),
                step("insert", INDEX, vec![("documents", documents)]),
                step(
                    "setting",
                    INDEX,
                    vec![("setting", setting_json(MIN_PEOPLE, MIN_RESULTS))],
                ),
                step(
                    "record",
                    INDEX,
                    vec![("queries", queries_json(&first_round()))],
                ),
                step(
                    "snapshot",
                    INDEX,
                    vec![
                        ("path", text(&reference_history.to_string_lossy())),
                        ("queryHistory", Value::Bool(true)),
                    ],
                ),
            ],
        ),
        scratch.path(),
    );
    for result in results_of(&made) {
        succeeded(&result);
    }

    let restored_root = scratch.path().join("crate-restored");
    let restored = open(&restored_root, Some(KEY));
    let warnings = warnings_of(&restored);
    let bytes = std::fs::read(&reference_history).expect("the snapshot reads");
    restored
        .restore(COPY, &mut bytes.as_slice())
        .expect("the crate restores the TypeScript snapshot");
    assert_eq!(
        listed_preview(&restored, COPY),
        preview_order(&once),
        "the crate restores the history that the TypeScript snapshot carries"
    );
    assert!(taken(&warnings).is_empty());
    restored.shutdown().expect("the engine shuts down");

    let keyless_root = scratch.path().join("crate-keyless");
    let keyless = open(&keyless_root, None);
    keyless
        .restore(COPY, &mut bytes.as_slice())
        .expect("an engine without a key restores the index");
    keyless.shutdown().expect("the engine shuts down");
    assert!(
        history_files(&keyless_root, COPY).is_empty(),
        "an engine without a key stores no restored search"
    );
}
