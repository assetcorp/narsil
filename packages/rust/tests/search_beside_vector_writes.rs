use std::sync::atomic::{AtomicBool, Ordering};

use narsil::{IndexConfig, Map, Narsil, QueryParams, QueryResult, Value, VectorQuery, parse_json};

const INDEX: &str = "notes";
const FIELD: &str = "embedding";
const NOTE_COUNT: u32 = 48;
const REVISION_ROUNDS: u32 = 120;
const CHURNED_NOTES: u32 = 12;
const CHURN_ROUNDS: u32 = 300;
const SEARCH_THREADS: usize = 3;
const SEARCHES_THAT_PROVE_OVERLAP: u64 = 50;

fn note(number: u32, revision: u32) -> Map {
    let mut map = Map::new();
    map.insert("id", Value::String(format!("note-{number:03}")));
    map.insert("title", Value::String(format!("field note {number}")));
    map.insert("revision", Value::Number(f64::from(revision)));
    map.insert(
        FIELD,
        Value::Array(vec![
            Value::Number(f64::from(revision)),
            Value::Number(f64::from(number + 1)),
            Value::Number(1.0),
        ]),
    );
    map
}

fn engine_with_notes() -> Narsil {
    let engine = Narsil::new();
    engine
        .create_index(
            INDEX,
            IndexConfig {
                schema: parse_json(
                    r#"{"title": "string", "revision": "number", "embedding": "vector[3]"}"#,
                )
                .expect("the schema is JSON"),
                ..IndexConfig::default()
            },
        )
        .expect("the index is created");
    let batch = engine
        .insert_batch(
            INDEX,
            (0..NOTE_COUNT).map(|number| note(number, 1)).collect(),
        )
        .expect("the notes are inserted");
    assert!(batch.failed.is_empty(), "a note was refused");
    engine
}

fn every_note_by_vector(term: Option<&str>) -> QueryParams {
    QueryParams {
        term: term.map(str::to_string),
        vector: Some(VectorQuery {
            field: FIELD.to_string(),
            value: Some(vec![1.0, 1.0, 1.0]),
            ..VectorQuery::default()
        }),
        limit: Some(NOTE_COUNT as usize * 2),
        ..QueryParams::default()
    }
}

fn revision_mismatch(result: &QueryResult) -> Option<String> {
    result.hits.iter().find_map(|hit| {
        let revision = hit.document.get("revision").and_then(Value::as_f64);
        let embedded = hit
            .document
            .get(FIELD)
            .and_then(Value::as_array)
            .and_then(|vector| vector.first())
            .and_then(Value::as_f64);
        match (revision, embedded) {
            (Some(revision), Some(embedded)) if revision == embedded => None,
            _ => Some(format!(
                "{} holds revision {revision:?} beside a vector of revision {embedded:?}",
                hit.id
            )),
        }
    })
}

fn searched_until_written(
    engine: &Narsil,
    written: &AtomicBool,
    params: &QueryParams,
    broken: impl Fn(&QueryResult) -> Option<String>,
) -> (u64, Option<String>) {
    let mut searches = 0;
    while !written.load(Ordering::Acquire) {
        let result = engine.query(INDEX, params).expect("the search answers");
        searches += 1;
        if let Some(found) = broken(&result) {
            return (searches, Some(found));
        }
    }
    (searches, None)
}

fn require_whole_answers(outcomes: Vec<(u64, Option<String>)>) {
    let searches: u64 = outcomes.iter().map(|(searches, _)| searches).sum();
    let broken: Vec<&String> = outcomes
        .iter()
        .filter_map(|(_, found)| found.as_ref())
        .collect();
    assert!(broken.is_empty(), "a search mixed two states: {broken:?}");
    assert!(
        searches >= SEARCHES_THAT_PROVE_OVERLAP,
        "only {searches} searches ran beside the writes, so the test proved nothing"
    );
}

#[test]
fn a_hit_carries_the_text_and_the_vector_of_one_write() {
    let engine = engine_with_notes();
    let written = AtomicBool::new(false);
    let outcomes = std::thread::scope(|scope| {
        let searchers: Vec<_> = (0..SEARCH_THREADS)
            .map(|thread| {
                let params = every_note_by_vector((thread % 2 == 1).then_some("field"));
                let (engine, written) = (&engine, &written);
                scope.spawn(move || {
                    searched_until_written(engine, written, &params, revision_mismatch)
                })
            })
            .collect();
        for revision in 2..REVISION_ROUNDS + 2 {
            for number in 0..NOTE_COUNT {
                engine
                    .update(INDEX, &format!("note-{number:03}"), note(number, revision))
                    .expect("the note is updated");
            }
        }
        written.store(true, Ordering::Release);
        searchers
            .into_iter()
            .map(|searcher| searcher.join().expect("the search thread returns"))
            .collect::<Vec<_>>()
    });
    require_whole_answers(outcomes);
}

fn miscounted(result: &QueryResult) -> Option<String> {
    if !result.count_exact || result.hits.len() as u64 == result.count {
        return None;
    }
    Some(format!(
        "the search counted {} matches and returned {} of them on a page with room for all",
        result.count,
        result.hits.len()
    ))
}

#[test]
fn a_vector_search_returns_every_document_that_it_counts() {
    let engine = engine_with_notes();
    let written = AtomicBool::new(false);
    let outcomes = std::thread::scope(|scope| {
        let searchers: Vec<_> = (0..SEARCH_THREADS)
            .map(|_| {
                let params = every_note_by_vector(None);
                let (engine, written) = (&engine, &written);
                scope.spawn(move || searched_until_written(engine, written, &params, miscounted))
            })
            .collect();
        for round in 0..CHURN_ROUNDS {
            for number in 0..CHURNED_NOTES {
                engine
                    .remove(INDEX, &format!("note-{number:03}"))
                    .expect("the note is removed");
            }
            for number in 0..CHURNED_NOTES {
                engine
                    .insert(INDEX, note(number, round + 2), None)
                    .expect("the note is inserted again");
            }
        }
        written.store(true, Ordering::Release);
        searchers
            .into_iter()
            .map(|searcher| searcher.join().expect("the search thread returns"))
            .collect::<Vec<_>>()
    });
    require_whole_answers(outcomes);
}
