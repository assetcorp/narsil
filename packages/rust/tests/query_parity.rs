mod support;

use narsil::{IndexConfig, Map, Value, parse_json};
use support::parity::{ParitySpec, conformance_searches, crate_outcomes, reference_outcomes};
use support::parity_cases::{
    answered_count, chosen_writes, index_config, query, require_same_outcomes,
};

const INDEX_NAME: &str = "bills";
const LIMIT_CROSSING_COUNT: usize = 33;

fn term_query(term: &str) -> Value {
    let mut map = Map::new();
    map.insert("term", Value::String(term.to_string()));
    map.insert("includeScores", Value::Bool(true));
    Value::Object(map)
}

fn phrase_queries() -> Vec<Value> {
    let many_phrases: Vec<String> = (0..LIMIT_CROSSING_COUNT)
        .map(|at| format!("\"revenue {at}\""))
        .collect();
    let long_phrase: Vec<String> = (0..LIMIT_CROSSING_COUNT)
        .map(|at| format!("word{at}"))
        .collect();
    vec![
        query(r#"{"term": "\"internal revenue code\""}"#),
        query(r#"{"term": "amend \"internal revenue code\" capital gains"}"#),
        query(r#"{"term": "“secondary education” grants"}"#),
        query(r#"{"term": "„secondary education”"}"#),
        query(r#"{"term": "\"to the united states\""}"#),
        query(r#"{"term": "\"act of 1998\""}"#),
        query(r#"{"term": "\"internal revenue code\" \"internal revenue code\""}"#),
        query(r#"{"term": "\"internal revenue\" \"revenue code\" amend"}"#),
        query(r#"{"term": "\"internal revenue code"}"#),
        query(r#"{"term": "\"\" energy"}"#),
        query(r#"{"term": "\"the of and\""}"#),
        query(r#"{"term": "\"the of and\" energy"}"#),
        query(r#"{"term": "\"revenue revenue\""}"#),
        query(r#"{"term": "\"code internal\""}"#),
        query(r#"{"term": "\"secretary of education\"", "fields": ["title"]}"#),
        query(r#"{"term": "\"secretary of education\"", "fields": ["summary"], "limit": 20}"#),
        query(r#"{"term": "\"internal revenue code\" amend tax", "termMatch": "all"}"#),
        query(r#"{"term": "\"internal revenue code\" amend tax credit", "termMatch": 2}"#),
        query(
            r#"{"term": "\"internal revenue code\" amend", "boost": {"title": 2.5, "summary": 0.5}}"#,
        ),
        query(r#"{"term": "\"internal revenue code\" amnd capitl", "tolerance": 1}"#),
        query(r#"{"term": "\"internal revenue code\" amnd", "tolerance": 2, "prefixLength": 0}"#),
        query(r#"{"term": "\"internal revenue code\" amend", "exact": true}"#),
        query(r#"{"term": "\"internal revenue code\"", "minScore": 12}"#),
        query(r#"{"term": "\"internal revenue code\"", "offset": 5, "limit": 7}"#),
        query(r#"{"term": "\"no such words anywhere\" energy"}"#),
        term_query(&many_phrases.join(" ")),
        term_query(&format!("\"{}\"", long_phrase.join(" "))),
        term_query(&format!("\"{}\"", long_phrase[..32].join(" "))),
    ]
}

fn edge_queries() -> Vec<Value> {
    vec![
        query(r#"{"term": "energy", "fields": ["embedding"]}"#),
        query(r#"{"term": "energy", "fields": ["missing"]}"#),
        query(r#"{"term": "energy", "fields": []}"#),
        query(r#"{"term": "   "}"#),
        query(r#"{"term": "﻿"}"#),
        query(r#"{"term": "energy", "tolerance": 11}"#),
        query(r#"{"term": "energy", "prefixLength": 1025}"#),
        query(r#"{"term": "energy", "limit": 9000, "offset": 1001}"#),
        query(r#"{"term": "energy", "limit": 0}"#),
        query(r#"{"term": "energy security", "termMatch": 3}"#),
        query(r#"{"term": "energy security", "termMatch": 0}"#),
    ]
}

fn prefix_queries() -> Vec<Value> {
    vec![
        query(r#"{"term": "internal reven", "prefix": true}"#),
        query(r#"{"term": "amending", "prefix": true}"#),
        query(r#"{"term": "educat", "prefix": true, "limit": 25}"#),
        query(r#"{"term": "secretary of", "prefix": true}"#),
        query(r#"{"term": "the", "prefix": true}"#),
        query(r#"{"term": "Hous", "prefix": true}"#),
        query(r#"{"term": "taxe", "prefix": true, "termMatch": "all"}"#),
        query(r#"{"term": "energy secur", "prefix": true, "termMatch": "all"}"#),
        query(r#"{"term": "energ secur", "prefix": true, "termMatch": 2, "tolerance": 1}"#),
        query(r#"{"term": "inter", "prefix": true, "exact": true}"#),
        query(r#"{"term": "inter", "prefix": true, "tolerance": 1}"#),
        query(r#"{"term": "inter", "prefix": true, "minScore": 3}"#),
        query(r#"{"term": "inter", "prefix": true, "fields": ["title"]}"#),
        query(r#"{"term": "inter", "prefix": false}"#),
        query(r#"{"term": "amend \"internal revenue code\"", "prefix": true}"#),
        query(r#"{"term": "\"internal revenue\" cod", "prefix": true}"#),
        query(r#"{"term": "zzzq", "prefix": true}"#),
        query(r#"{"term": "a", "prefix": true}"#),
    ]
}

#[test]
fn text_queries_after_writes_answer_exactly_as_the_reference_does() {
    let searches = conformance_searches();
    let (removals, updates) = chosen_writes();
    assert_eq!(removals.len(), 3, "the dataset holds documents to remove");
    assert_eq!(updates.len(), 2, "the dataset holds documents to update");
    let spec = ParitySpec {
        index: INDEX_NAME.to_string(),
        config: Map::new(),
        removals,
        updates,
        synonym_updates: Vec::new(),
        queries: phrase_queries()
            .into_iter()
            .chain(edge_queries())
            .chain(prefix_queries())
            .collect(),
    };
    let wanted = reference_outcomes(&spec);
    let found = crate_outcomes(&spec, index_config(&searches));
    let answered = answered_count(&wanted);
    assert!(
        answered >= 20,
        "only {answered} reference queries return hits"
    );
    require_same_outcomes(&spec, &found, &wanted);
}

#[test]
fn prefix_queries_without_surface_forms_answer_exactly_as_the_reference_does() {
    let searches = conformance_searches();
    let (removals, updates) = chosen_writes();
    let mut config = Map::new();
    config.insert("surfaceForms", Value::Bool(false));
    let spec = ParitySpec {
        index: INDEX_NAME.to_string(),
        config,
        removals,
        updates,
        synonym_updates: Vec::new(),
        queries: prefix_queries(),
    };
    let wanted = reference_outcomes(&spec);
    let crate_config = IndexConfig {
        surface_forms: Some(false),
        ..index_config(&searches)
    };
    let found = crate_outcomes(&spec, crate_config);
    require_same_outcomes(&spec, &found, &wanted);
}

fn partial_word_queries() -> Vec<Value> {
    vec![
        query(r#"{"term": "venue", "partialWords": true}"#),
        query(r#"{"term": "venue code", "partialWords": true, "limit": 30}"#),
        query(r#"{"term": "educ", "partialWords": true}"#),
        query(r#"{"term": "struct", "partialWords": true, "termMatch": "all"}"#),
        query(r#"{"term": "struct infra", "partialWords": true, "termMatch": 2}"#),
        query(r#"{"term": "venu", "partialWords": true, "tolerance": 1}"#),
        query(r#"{"term": "venue", "partialWords": true, "tolerance": 2, "prefixLength": 0}"#),
        query(r#"{"term": "venue", "partialWords": true, "exact": true}"#),
        query(r#"{"term": "venue", "partialWords": true, "fields": ["title"]}"#),
        query(r#"{"term": "venue", "partialWords": true, "fields": ["title", "summary"]}"#),
        query(r#"{"term": "venue", "partialWords": false}"#),
        query(r#"{"term": "internal reven", "partialWords": true, "prefix": true}"#),
        query(r#"{"term": "tax ven", "partialWords": true, "prefix": true}"#),
        query(r#"{"term": "\"internal revenue\" venue", "partialWords": true}"#),
        query(r#"{"term": "ab xy", "partialWords": true}"#),
        query(r#"{"term": "venue", "partialWords": true, "minScore": 2}"#),
        query(r#"{"term": "venues", "partialWords": true}"#),
        query(r#"{"term": "zzzqqq", "partialWords": true}"#),
    ]
}

#[test]
fn partial_word_queries_after_writes_answer_exactly_as_the_reference_does() {
    let searches = conformance_searches();
    let (removals, updates) = chosen_writes();
    let schema = parse_json(
        r#"{"title": "string", "summary": "string:partial", "embedding": "vector[384]"}"#,
    )
    .expect("the schema is JSON");
    let mut config = Map::new();
    config.insert("schema", schema.clone());
    let spec = ParitySpec {
        index: INDEX_NAME.to_string(),
        config,
        removals,
        updates,
        synonym_updates: Vec::new(),
        queries: partial_word_queries(),
    };
    let wanted = reference_outcomes(&spec);
    let answered = answered_count(&wanted);
    assert!(
        answered >= 12,
        "only {answered} reference queries return hits"
    );
    let crate_config = IndexConfig {
        schema,
        ..index_config(&searches)
    };
    let found = crate_outcomes(&spec, crate_config);
    require_same_outcomes(&spec, &found, &wanted);
}
