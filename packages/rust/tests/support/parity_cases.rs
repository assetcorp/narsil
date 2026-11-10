use narsil::{IndexConfig, Map, Value, parse_json};

use super::parity::{Outcome, ParitySpec, dataset_documents, differences};

pub fn query(json: &str) -> Value {
    let mut value = parse_json(json).expect("the query is JSON");
    if let Some(map) = value.as_object_mut() {
        map.insert("includeScores", Value::Bool(true));
    }
    value
}

pub fn chosen_writes() -> (Vec<String>, Vec<(String, Map)>) {
    let documents = dataset_documents();
    let id_of = |document: &Map| {
        document
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let holds = |document: &Map, words: &str| {
        document
            .get("summary")
            .and_then(Value::as_str)
            .is_some_and(|summary| summary.contains(words))
    };
    let removals: Vec<String> = documents
        .iter()
        .filter(|document| holds(document, "Internal Revenue Code"))
        .take(3)
        .map(id_of)
        .collect();
    let updated: Vec<String> = documents
        .iter()
        .filter(|document| holds(document, "Secretary of Education"))
        .take(2)
        .map(id_of)
        .collect();
    let mut updates = Vec::new();
    for (at, id) in updated.into_iter().enumerate() {
        let mut document = Map::new();
        document.insert("id", Value::String(id.clone()));
        document.insert(
            "title",
            Value::String(format!(
                "Internal Revenue Code and the internal revenue code, edition {at}"
            )),
        );
        document.insert(
            "summary",
            Value::String(
                "To amend the Internal Revenue Code, then amend the internal revenue code again."
                    .into(),
            ),
        );
        updates.push((id, document));
    }
    (removals, updates)
}

pub fn index_config(searches: &Value) -> IndexConfig {
    IndexConfig {
        schema: searches.pointer("index.schema").cloned().expect("a schema"),
        language: searches
            .pointer("index.language")
            .and_then(Value::as_str)
            .map(str::to_string),
        ..IndexConfig::default()
    }
}

pub fn answered_count(outcomes: &[Outcome]) -> usize {
    outcomes
        .iter()
        .filter(|outcome| matches!(outcome, Outcome::Hits { hits, .. } if !hits.is_empty()))
        .count()
}

pub fn require_same_outcomes(spec: &ParitySpec, found: &[Outcome], wanted: &[Outcome]) {
    let problems = differences(spec, found, wanted);
    assert!(
        problems.is_empty(),
        "{} of {} steps differ:\n{}",
        problems.len(),
        found.len(),
        problems.join("\n")
    );
}
