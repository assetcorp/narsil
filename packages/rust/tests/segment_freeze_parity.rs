mod support;

use narsil::{IndexConfig, Map, Narsil, Value, parse_json};
use support::parity::{
    INSERT_BATCH_DOCUMENTS, Outcome, ParitySpec, apply_writes, conformance_searches,
    dataset_documents, differences, engine_outcomes, load_engine, reference_outcomes,
    synonym_rules,
};
use support::parity_cases::{answered_count, chosen_writes, index_config, query};

const INDEX_NAME: &str = "bills";
const BATCHES_PER_FROZEN_SEGMENT: usize = 4;
const TAIL_REMOVALS: usize = 3;

fn json(text: &str) -> Value {
    parse_json(text).expect("the value is JSON")
}

fn id_of(document: &Map) -> String {
    document
        .get("id")
        .and_then(Value::as_str)
        .expect("each document holds an ID")
        .to_string()
}

fn writes_reaching_the_tail() -> (Vec<String>, Vec<(String, Map)>) {
    let (mut removals, mut updates) = chosen_writes();
    let documents = dataset_documents();
    let last_batch = documents
        .len()
        .checked_sub(INSERT_BATCH_DOCUMENTS)
        .and_then(|start| documents.get(start..))
        .expect("the dataset holds a full last batch");
    removals.extend(last_batch.iter().take(TAIL_REMOVALS).map(id_of));
    let updated = last_batch
        .get(TAIL_REMOVALS)
        .expect("the last batch holds a document to update");
    let mut document = updated.clone();
    document.insert(
        "summary",
        Value::String(
            "Amends the Internal Revenue Code to levy a duty on school power grids.".into(),
        ),
    );
    updates.push((id_of(updated), document));
    (removals, updates)
}

fn require_stage(stage: &str, spec: &ParitySpec, engine: &Narsil, wanted: &[Outcome]) {
    let found = engine_outcomes(engine, spec);
    let problems = differences(spec, &found, wanted);
    assert!(
        problems.is_empty(),
        "{stage}: {} of {} steps differ:\n{}",
        problems.len(),
        found.len(),
        problems.join("\n")
    );
}

fn require_every_stage(spec: &ParitySpec, config: IndexConfig) {
    let wanted = reference_outcomes(spec);
    let batches = dataset_documents().len().div_ceil(INSERT_BATCH_DOCUMENTS);
    let engine = Narsil::new();
    load_engine(&engine, spec, config, &mut |at| {
        let inserted = at + 1;
        if inserted % BATCHES_PER_FROZEN_SEGMENT == 0 && inserted < batches {
            engine
                .freeze_tail_segments(&spec.index)
                .expect("the tail freezes");
        }
    });
    apply_writes(&engine, spec);
    require_stage(
        "frozen segments with removals beside a tail with removals",
        spec,
        &engine,
        &wanted,
    );
    engine
        .freeze_tail_segments(&spec.index)
        .expect("the tail freezes after the writes");
    require_stage("every segment frozen", spec, &engine, &wanted);
    engine
        .merge_partition_segments(&spec.index)
        .expect("the segments merge");
    require_stage("one merged segment per partition", spec, &engine, &wanted);
    assert!(
        answered_count(&wanted) * 2 >= wanted.len(),
        "the reference answers too few queries"
    );
}

fn text_queries() -> Vec<Value> {
    vec![
        query(r#"{"term": "\"internal revenue code\""}"#),
        query(r#"{"term": "amend \"internal revenue code\" capital gains"}"#),
        query(r#"{"term": "\"secretary of education\"", "fields": ["summary"], "limit": 20}"#),
        query(r#"{"term": "\"internal revenue code\" amend tax", "termMatch": "all"}"#),
        query(r#"{"term": "\"internal revenue code\" amnd capitl", "tolerance": 1}"#),
        query(r#"{"term": "\"internal revenue code\"", "offset": 5, "limit": 7}"#),
        query(r#"{"term": "energy", "limit": 50}"#),
        query(r#"{"term": "internal reven", "prefix": true}"#),
        query(r#"{"term": "educat", "prefix": true, "limit": 25}"#),
        query(r#"{"term": "Hous", "prefix": true}"#),
        query(r#"{"term": "energ secur", "prefix": true, "termMatch": 2, "tolerance": 1}"#),
        query(r#"{"term": "inter", "prefix": true, "fields": ["title"]}"#),
        query(r#"{"term": "taxe", "prefix": true, "termMatch": "all"}"#),
        query(r#"{"term": "levy"}"#),
        query(r#"{"term": "taxes credits", "limit": 25}"#),
        query(r#"{"term": "school"}"#),
        query(r#"{"term": "power grid", "termMatch": "all"}"#),
        query(r#"{"term": "levi", "tolerance": 1}"#),
        query(r#"{"term": "lev", "prefix": true}"#),
        query(r#"{"term": "\"internal revenue\" levy"}"#),
        query(r#"{"term": "healthcare levy duty", "minScore": 4}"#),
        query(r#"{"term": "agricultre", "tolerance": 2, "prefixLength": 0}"#),
        query(r#"{"term": "the", "limit": 40}"#),
    ]
}

#[test]
fn freezing_and_merging_segments_keeps_text_searches_identical_to_the_reference() {
    let searches = conformance_searches();
    let (removals, updates) = writes_reaching_the_tail();
    let rules = json(
        r#"[
            {"words": ["tax", "levy", "duty"]},
            {"word": "school", "synonyms": ["education", "academy", "schools"]},
            {"words": ["energy", "power"]},
            {"words": ["health", "medical", "healthcare"]}
        ]"#,
    );
    let mut config = Map::new();
    config.insert("synonyms", rules.clone());
    let spec = ParitySpec {
        index: INDEX_NAME.to_string(),
        config,
        removals,
        updates,
        synonym_updates: Vec::new(),
        queries: text_queries(),
    };
    let crate_config = IndexConfig {
        synonyms: Some(synonym_rules(&rules)),
        ..index_config(&searches)
    };
    require_every_stage(&spec, crate_config);
}

fn partial_word_queries() -> Vec<Value> {
    vec![
        query(r#"{"term": "venue", "partialWords": true}"#),
        query(r#"{"term": "venue code", "partialWords": true, "limit": 30}"#),
        query(r#"{"term": "educ", "partialWords": true}"#),
        query(r#"{"term": "struct infra", "partialWords": true, "termMatch": 2}"#),
        query(r#"{"term": "venu", "partialWords": true, "tolerance": 1}"#),
        query(r#"{"term": "venue", "partialWords": true, "fields": ["summary"]}"#),
        query(r#"{"term": "tax ven", "partialWords": true, "prefix": true}"#),
        query(r#"{"term": "\"internal revenue\" venue", "partialWords": true}"#),
        query(r#"{"term": "rammar", "partialWords": true}"#),
        query(r#"{"term": "ower gri", "partialWords": true}"#),
        query(r#"{"term": "venues", "partialWords": true}"#),
    ]
}

#[test]
fn freezing_and_merging_segments_keeps_partial_word_searches_identical_to_the_reference() {
    let searches = conformance_searches();
    let (removals, updates) = writes_reaching_the_tail();
    let schema =
        json(r#"{"title": "string", "summary": "string:partial", "embedding": "vector[384]"}"#);
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
    let crate_config = IndexConfig {
        schema,
        ..index_config(&searches)
    };
    require_every_stage(&spec, crate_config);
}
