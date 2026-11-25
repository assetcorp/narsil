use std::sync::mpsc::{TrySendError, sync_channel};

use narsil::{
    DocumentProjection, IndexConfig, Map, Narsil, QueryParams, QueryResult, Value, VectorQuery,
    parse_json,
};

const INDEX: &str = "notes";
const FIELD: &str = "embedding";
const NOTE_COUNT: u32 = 48;
const REVISION_ROUNDS: u32 = 120;
const CHURNED_NOTES: u32 = 12;
const CHURN_ROUNDS: u32 = 300;

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
        document: Some(DocumentProjection::Fields {
            include: None,
            exclude: None,
            vectors: Some(true),
        }),
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

fn search_during_writes(
    engine: &Narsil,
    terms: [Option<&str>; 3],
    rounds: u32,
    write_round: impl Fn(u32),
    broken: fn(&QueryResult) -> Option<String>,
) {
    std::thread::scope(|scope| {
        let readers: Vec<_> = terms
            .into_iter()
            .map(|term| {
                let params = every_note_by_vector(term);
                let (searched, completed) = sync_channel(1);
                scope.spawn(move || {
                    loop {
                        let result = engine.query(INDEX, &params).expect("the search answers");
                        if let Some(problem) = broken(&result) {
                            panic!("a search mixed two states: {problem}");
                        }
                        if let Err(TrySendError::Disconnected(())) = searched.try_send(()) {
                            break;
                        }
                    }
                });
                completed
            })
            .collect();
        for round in 0..rounds {
            write_round(round);
            for reader in &readers {
                reader.recv().expect("the search thread finished a query");
            }
        }
    });
}

#[test]
fn a_hit_carries_the_text_and_the_vector_of_one_write() {
    let engine = engine_with_notes();
    search_during_writes(
        &engine,
        [None, Some("field"), None],
        REVISION_ROUNDS,
        |round| {
            for number in 0..NOTE_COUNT {
                engine
                    .update(INDEX, &format!("note-{number:03}"), note(number, round + 2))
                    .expect("the note is updated");
            }
        },
        revision_mismatch,
    );
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
    search_during_writes(
        &engine,
        [None; 3],
        CHURN_ROUNDS,
        |round| {
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
        },
        miscounted,
    );
}
