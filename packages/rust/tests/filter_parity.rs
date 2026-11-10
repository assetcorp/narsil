mod support;

use std::collections::BTreeSet;
use std::path::Path;

use narsil::{
    DurabilityConfig, DurabilityMode, IndexConfig, Map, Narsil, NarsilConfig, PartitionConfig,
    ScoringMode, Storage, Value, VectorPromotion, parse_json, write_json,
};
use support::ScratchDirectory;
use support::filter_parity::{
    FilterSpec, Kind, Operation, Outcome, Write, apply_writes, crate_outcomes, engine_outcomes,
    hits_answered, operation, reference, require_same,
};
use support::parity::{
    DATASET_VECTOR_FIELD, INSERT_BATCH_DOCUMENTS, dataset_documents, dataset_vectors, vector_value,
};

const INDEX_NAME: &str = "bills";
const ROWS: usize = 3_000;
const FROZEN_ROWS: usize = 2_000;
const PARTITIONS: u64 = 4;
const BRUTE_FORCE_THRESHOLD: u64 = 1_000_000;
const QUERY_VECTOR_ROW: usize = 5;
const REMOVED_ROWS: [usize; 4] = [3, 10, 1_500, 2_005];
const UPDATED_ROWS: [usize; 2] = [7, 2_010];
const CATEGORIES: [&str; 5] = ["energy", "health", "tax", "education", "defence"];
const SPONSORS: [&str; 8] = [
    "Adams", "baker", "Carter", "dawson", "Ellis", "Foster", "garcia", "Hughes",
];
const CHAMBERS: [&str; 4] = ["HR", "S", "HJRES", "SRES"];
const MAX_FILTER_DEPTH: usize = 30;
const MAX_FILTER_TESTS: usize = 1_024;
const MAX_FILTER_ARRAY_SIZE: usize = 65_536;
const MAX_PATTERN_TEXT_CODE_POINTS: usize = 1_024;
const SMALL_PATTERN_WORK_CAP: u64 = 2_000;

const SCHEMA: &str = r#"{
    "title": "string",
    "summary": "string",
    "embedding": "vector[384]",
    "year": "number",
    "category": "enum",
    "tags": "enum[]",
    "ratings": "number[]",
    "active": "boolean",
    "flags": "boolean[]",
    "location": "geopoint",
    "code": "string:pattern",
    "sponsor": "string:sortable",
    "label": "verbatim"
}"#;

fn id_of_row(row: usize) -> String {
    format!("train-{row:05}")
}

fn enriched(row: usize, mut document: Map, vector: &[f32]) -> Map {
    document.insert("year", Value::Number((1_990 + (row * 7) % 35) as f64));
    document.insert("category", Value::String(CATEGORIES[row % 5].into()));
    if row % 13 != 0 {
        let mut tags: Vec<&str> = Vec::new();
        if row % 11 != 0 {
            tags.push(CATEGORIES[row % 5]);
            let second = CATEGORIES[(row * 3 + 1) % 5];
            if !tags.contains(&second) {
                tags.push(second);
            }
        }
        let tags = tags
            .into_iter()
            .map(|tag| Value::String(tag.into()))
            .collect();
        document.insert("tags", Value::Array(tags));
    }
    let ratings = match row % 17 {
        0 => Vec::new(),
        _ => vec![(row % 10) as f64, ((row * 3) % 10) as f64],
    };
    document.insert(
        "ratings",
        Value::Array(ratings.into_iter().map(Value::Number).collect()),
    );
    if row % 19 != 0 {
        document.insert("active", Value::Bool(row % 3 == 0));
    }
    document.insert(
        "flags",
        Value::Array(vec![Value::Bool(row % 2 == 0), Value::Bool(row % 5 == 0)]),
    );
    let mut location = Map::new();
    location.insert(
        "lat",
        Value::Number(-60.0 + ((row * 37) % 120) as f64 + 0.25),
    );
    location.insert(
        "lon",
        Value::Number(-170.0 + ((row * 53) % 340) as f64 + 0.5),
    );
    document.insert("location", Value::Object(location));
    document.insert(
        "code",
        Value::String(format!("{}-{row:04}", CHAMBERS[row % 4])),
    );
    document.insert(
        "sponsor",
        Value::String(format!("{} {row}", SPONSORS[row % 8])),
    );
    let house = if row % 2 == 0 { "House" } else { "senate" };
    document.insert("label", Value::String(format!("{house} Bill {row}")));
    document.insert(DATASET_VECTOR_FIELD, vector_value(vector));
    document
}

struct Dataset {
    documents: Vec<Map>,
    vectors: Vec<Vec<f32>>,
}

fn dataset() -> Dataset {
    let vectors: Vec<Vec<f32>> = dataset_vectors().into_iter().take(ROWS).collect();
    let documents = dataset_documents()
        .into_iter()
        .take(ROWS)
        .enumerate()
        .map(|(row, document)| enriched(row, document, &vectors[row]))
        .collect();
    Dataset { documents, vectors }
}

fn updated_document(row: usize, documents: &[Map]) -> Map {
    let mut document = documents[row].clone();
    document.insert("year", Value::Number(2_024.0));
    document.insert("category", Value::String("tax".into()));
    document.insert("tags", Value::Array(vec![Value::String("health".into())]));
    document.insert("code", Value::String("HR-9999".into()));
    document.remove("active");
    let mut location = Map::new();
    location.insert("lat", Value::Number(1.0));
    location.insert("lon", Value::Number(1.0));
    document.insert("location", Value::Object(location));
    document
}

fn writes(data: &Dataset) -> Vec<Write> {
    let mut writes: Vec<Write> = data.documents[..FROZEN_ROWS]
        .chunks(INSERT_BATCH_DOCUMENTS)
        .map(|batch| Write::Insert(batch.to_vec()))
        .collect();
    writes.push(Write::Freeze);
    writes.extend(
        data.documents[FROZEN_ROWS..]
            .chunks(INSERT_BATCH_DOCUMENTS)
            .map(|batch| Write::Insert(batch.to_vec())),
    );
    writes.push(Write::Remove(
        REMOVED_ROWS.iter().map(|&row| id_of_row(row)).collect(),
    ));
    writes.push(Write::Update(
        UPDATED_ROWS
            .iter()
            .map(|&row| (id_of_row(row), updated_document(row, &data.documents)))
            .collect(),
    ));
    writes
}

fn schema() -> Value {
    parse_json(SCHEMA).expect("the schema is JSON")
}

fn reference_config(partitions: u64) -> Map {
    let text = format!(
        r#"{{"schema": {SCHEMA}, "language": "english", "partitions": {{"maxPartitions": {partitions}}}, "vectorPromotion": {{"threshold": {BRUTE_FORCE_THRESHOLD}}}}}"#
    );
    parse_json(&text)
        .expect("the config is JSON")
        .as_object()
        .expect("the config is an object")
        .clone()
}

fn crate_config(partitions: u64) -> IndexConfig {
    IndexConfig {
        schema: schema(),
        language: Some("english".into()),
        partitions: Some(PartitionConfig {
            max_partitions: Some(partitions),
            ..PartitionConfig::default()
        }),
        vector_promotion: Some(VectorPromotion {
            threshold: Some(BRUTE_FORCE_THRESHOLD),
            ..VectorPromotion::default()
        }),
        ..IndexConfig::default()
    }
}

const FILTERS: [&str; 52] = [
    r#"{}"#,
    r#"{"fields": {"year": {"gte": 2000, "lt": 2010}}}"#,
    r#"{"fields": {"year": {"between": [1995, 2005]}}}"#,
    r#"{"fields": {"year": {"eq": 2001}}}"#,
    r#"{"fields": {"year": {"ne": 2001}}}"#,
    r#"{"fields": {"year": {"gt": 2024}}}"#,
    r#"{"fields": {"category": {"eq": "tax"}}}"#,
    r#"{"fields": {"category": {"ne": "tax"}}}"#,
    r#"{"fields": {"category": {"in": ["tax", "energy", "missing"]}}}"#,
    r#"{"fields": {"category": {"nin": ["tax", "energy"]}}}"#,
    r#"{"fields": {"category": {"startsWith": "ed"}}}"#,
    r#"{"fields": {"category": {"endsWith": "th"}}}"#,
    r#"{"fields": {"tags": {"eq": "health"}}}"#,
    r#"{"fields": {"tags": {"ne": "health"}}}"#,
    r#"{"fields": {"tags": {"containsAll": ["health", "defence"]}}}"#,
    r#"{"fields": {"tags": {"matchesAny": ["health", "defence"]}}}"#,
    r#"{"fields": {"tags": {"size": {"gte": 2}}}}"#,
    r#"{"fields": {"tags": {"isEmpty": true}}}"#,
    r#"{"fields": {"tags": {"isNotEmpty": true}}}"#,
    r#"{"fields": {"tags": {"notExists": true}}}"#,
    r#"{"fields": {"ratings": {"gt": 5}}}"#,
    r#"{"fields": {"ratings": {"containsAll": [1, 3]}}}"#,
    r#"{"fields": {"ratings": {"matchesAny": [9, 0]}}}"#,
    r#"{"fields": {"ratings": {"size": {"eq": 0}}}}"#,
    r#"{"fields": {"active": {"eq": true}}}"#,
    r#"{"fields": {"active": {"ne": true}}}"#,
    r#"{"fields": {"active": {"exists": false}}}"#,
    r#"{"fields": {"flags": {"containsAll": [true, false]}}}"#,
    r#"{"fields": {"flags": {"matchesAny": [true]}}}"#,
    r#"{"fields": {"location": {"radius": {"lat": 0, "lon": 0, "distance": 4000, "unit": "km"}}}}"#,
    r#"{"fields": {"location": {"radius": {"lat": 10, "lon": 20, "distance": 3000, "unit": "mi", "inside": false, "highPrecision": true}}}}"#,
    r#"{"fields": {"location": {"polygon": {"points": [{"lat": -30, "lon": -60}, {"lat": -30, "lon": 60}, {"lat": 40, "lon": 60}, {"lat": 40, "lon": -60}]}}}}"#,
    r#"{"fields": {"location": {"polygon": {"points": [{"lat": -30, "lon": 170}, {"lat": -30, "lon": -170}, {"lat": 30, "lon": -170}, {"lat": 30, "lon": 170}], "inside": false}}}}"#,
    r#"{"fields": {"code": {"startsWith": "HR-"}}}"#,
    r#"{"fields": {"code": {"endsWith": "7"}}}"#,
    r#"{"fields": {"code": {"contains": "RES-00"}}}"#,
    r#"{"fields": {"code": {"wildcard": "S-*1"}}}"#,
    r#"{"fields": {"code": {"regex": "HJRES-0[0-4][0-9]+"}}}"#,
    r#"{"fields": {"code": {"eq": "hr-0040", "caseFold": true}}}"#,
    r#"{"fields": {"code": {"eq": "HR-0041", "tolerance": 1}}}"#,
    r#"{"fields": {"code": {"in": ["HR-0004", "S-0005", "HR-9999"]}}}"#,
    r#"{"fields": {"code": {"nin": ["HR-0004", "S-0005"]}}}"#,
    r#"{"fields": {"sponsor": {"gte": "E"}}}"#,
    r#"{"fields": {"sponsor": {"between": ["b", "D"]}}}"#,
    r#"{"fields": {"sponsor": {"lt": "c"}}}"#,
    r#"{"fields": {"label": {"eq": "house bill 12", "caseFold": true}}}"#,
    r#"{"fields": {"label": {"startsWith": "senate Bill 1"}}}"#,
    r#"{"and": [{"fields": {"category": {"eq": "tax"}}}, {"fields": {"year": {"gte": 2005}}}]}"#,
    r#"{"or": [{"fields": {"category": {"eq": "health"}}}, {"fields": {"active": {"eq": true}}}]}"#,
    r#"{"not": {"fields": {"category": {"in": ["tax", "health"]}}}}"#,
    r#"{"fields": {"year": {"gte": 2000}}, "or": [{"fields": {"tags": {"isEmpty": true}}}, {"not": {"fields": {"flags": {"matchesAny": [false]}}}}]}"#,
    r#"{"fields": {"category": {"eq": "nothing"}}}"#,
];

const TERMS: [&str; 3] = ["tax", "energy security", "\"internal revenue code\""];

fn with_filter(json: &str, filter: &str) -> String {
    let mut value = parse_json(json).expect("the operation is JSON");
    if let Some(map) = value.as_object_mut() {
        map.insert("filters", parse_json(filter).expect("the filter is JSON"));
    }
    write_json(&value)
}

fn vector_json(data: &Dataset) -> String {
    write_json(&vector_value(&data.vectors[QUERY_VECTOR_ROW]))
}

fn filtered_operations(data: &Dataset) -> Vec<Operation> {
    let vector = vector_json(data);
    let mut operations = Vec::new();
    for (at, filter) in FILTERS.iter().enumerate() {
        let term = TERMS[at % TERMS.len()];
        let text = format!(
            r#"{{"term": "{}", "limit": 15, "includeScores": true}}"#,
            term.replace('"', "\\\"")
        );
        operations.push(operation(Kind::Query, &with_filter(&text, filter)));
        operations.push(operation(
            Kind::Query,
            &with_filter(
                r#"{"term": "a", "prefix": true, "tolerance": 1, "limit": 5}"#,
                filter,
            ),
        ));
        operations.push(operation(
            Kind::ListAll,
            &with_filter(r#"{"limit": 700}"#, filter),
        ));
        operations.push(operation(Kind::Preflight, &with_filter(&text, filter)));
        let vector_query =
            format!(r#"{{"vector": {{"field": "embedding", "value": {vector}}}, "limit": 12}}"#);
        operations.push(operation(Kind::Query, &with_filter(&vector_query, filter)));
        let hybrid_query = format!(
            r#"{{"term": "{}", "vector": {{"field": "embedding", "value": {vector}}}, "limit": 12}}"#,
            term.replace('"', "\\\"")
        );
        operations.push(operation(Kind::Query, &with_filter(&hybrid_query, filter)));
    }
    let vector_preflight =
        format!(r#"{{"vector": {{"field": "embedding", "value": {vector}, "similarity": 0.2}}}}"#);
    let fixed_hybrid = format!(
        r#"{{"term": "tax", "vector": {{"field": "embedding", "value": {vector}}}, "hybrid": {{"depth": 40}}, "limit": 10}}"#
    );
    for filter in [FILTERS[1], FILTERS[29], FILTERS[51]] {
        operations.push(operation(
            Kind::Preflight,
            &with_filter(&vector_preflight, filter),
        ));
        operations.push(operation(Kind::Query, &with_filter(&fixed_hybrid, filter)));
        operations.push(operation(
            Kind::Query,
            &with_filter(r#"{"term": "tax", "limit": 5, "offset": 9990}"#, filter),
        ));
    }
    operations
}

fn nested(depth: usize) -> String {
    let mut filter = r#"{"fields": {"year": {"gt": 1}}}"#.to_string();
    for _ in 0..depth {
        filter = format!(r#"{{"not": {filter}}}"#);
    }
    filter
}

fn many_tests(count: usize) -> String {
    let tests: Vec<String> = (0..count)
        .map(|at| format!(r#"{{"fields": {{"year": {{"eq": {at}}}}}}}"#))
        .collect();
    format!(r#"{{"or": [{}]}}"#, tests.join(","))
}

fn long_list(count: usize) -> String {
    let values: Vec<String> = (0..count).map(|at| format!("\"v{at}\"")).collect();
    format!(
        r#"{{"fields": {{"category": {{"in": [{}]}}}}}}"#,
        values.join(",")
    )
}

fn long_polygon(count: usize) -> String {
    let points: Vec<String> = (0..count)
        .map(|at| {
            let angle = at as f64 * std::f64::consts::TAU / count as f64;
            format!(
                r#"{{"lat": {}, "lon": {}}}"#,
                40.0 * angle.sin(),
                80.0 * angle.cos()
            )
        })
        .collect();
    format!(
        r#"{{"fields": {{"location": {{"polygon": {{"points": [{}]}}}}}}}}"#,
        points.join(",")
    )
}

fn hostile_filters() -> Vec<String> {
    let mut filters: Vec<String> = [
        r#""tax""#,
        r#"[]"#,
        r#"null"#,
        r#"{"bogus": 1}"#,
        r#"{"fields": []}"#,
        r#"{"fields": {"missing": {"eq": 1}}}"#,
        r#"{"fields": {"year": 2001}}"#,
        r#"{"fields": {"year": {"eq": "2001"}}}"#,
        r#"{"fields": {"year": {"gt": "a"}}}"#,
        r#"{"fields": {"year": {"between": [1]}}}"#,
        r#"{"fields": {"year": {"between": [2001, "x"]}}}"#,
        r#"{"fields": {"year": {"wat": 1}}}"#,
        r#"{"fields": {"year": {"size": {"gt": 1}}}}"#,
        r#"{"fields": {"year": {"in": ["1"]}}}"#,
        r#"{"fields": {"category": {"in": "tax"}}}"#,
        r#"{"fields": {"category": {"in": [1, 2]}}}"#,
        r#"{"fields": {"category": {"eq": true}}}"#,
        r#"{"fields": {"category": {"contains": "ta"}}}"#,
        r#"{"fields": {"tags": {"size": {"eq": "x"}}}}"#,
        r#"{"fields": {"tags": {"containsAll": "tax"}}}"#,
        r#"{"fields": {"title": {"eq": "x"}}}"#,
        r#"{"fields": {"title": {"contains": "x"}}}"#,
        r#"{"fields": {"title": {"gt": "x"}}}"#,
        r#"{"fields": {"embedding": {"eq": 1}}}"#,
        r#"{"fields": {"active": {"exists": "yes"}}}"#,
        r#"{"fields": {"active": {"eq": 1}}}"#,
        r#"{"fields": {"code": {"regex": "("}}}"#,
        r#"{"fields": {"code": {"regex": "a{99999}"}}}"#,
        r#"{"fields": {"code": {"wildcard": 5}}}"#,
        r#"{"fields": {"code": {"eq": "HR", "tolerance": 3}}}"#,
        r#"{"fields": {"code": {"eq": "HR", "tolerance": "some"}}}"#,
        r#"{"fields": {"code": {"caseFold": "yes", "eq": "HR"}}}"#,
        r#"{"fields": {"sponsor": {"gt": 5}}}"#,
        r#"{"fields": {"location": {"eq": 1}}}"#,
        r#"{"fields": {"location": {"radius": {"lat": 91, "lon": 0, "distance": 1, "unit": "km"}}}}"#,
        r#"{"fields": {"location": {"radius": {"lat": 0, "lon": 0, "distance": -1, "unit": "km"}}}}"#,
        r#"{"fields": {"location": {"radius": {"lat": 0, "lon": 0, "distance": 1, "unit": "parsec"}}}}"#,
        r#"{"fields": {"location": {"radius": {"lat": 0, "lon": 0}}}}"#,
        r#"{"fields": {"location": {"polygon": {"points": [{"lat": 0, "lon": 0}]}}}}"#,
        r#"{"fields": {"location": {"polygon": {"points": [{"lat": 0, "lon": 0}, {"lat": 1, "lon": 1}, {"lat": 0, "lon": 200}]}}}}"#,
        r#"{"fields": {"location": {"polygon": "square"}}}"#,
        r#"{"and": {"fields": {"year": {"eq": 1}}}}"#,
        r#"{"or": [5]}"#,
        r#"{"not": []}"#,
    ]
    .iter()
    .map(|filter| filter.to_string())
    .collect();
    filters.push(nested(MAX_FILTER_DEPTH));
    filters.push(nested(MAX_FILTER_DEPTH + 1));
    filters.push(many_tests(MAX_FILTER_TESTS));
    filters.push(many_tests(MAX_FILTER_TESTS + 1));
    filters.push(long_list(MAX_FILTER_ARRAY_SIZE + 1));
    filters.push(long_polygon(MAX_FILTER_ARRAY_SIZE + 1));
    filters.push(long_polygon(2_000));
    let long_text = "x".repeat(MAX_PATTERN_TEXT_CODE_POINTS + 1);
    filters.push(format!(
        r#"{{"fields": {{"code": {{"contains": "{long_text}"}}}}}}"#
    ));
    filters
}

fn hostile_operations() -> Vec<Operation> {
    let mut operations = Vec::new();
    for filter in hostile_filters() {
        operations.push(operation(
            Kind::Query,
            &with_filter(r#"{"term": "tax", "limit": 3}"#, &filter),
        ));
        operations.push(operation(
            Kind::List,
            &with_filter(r#"{"limit": 3}"#, &filter),
        ));
        operations.push(operation(
            Kind::Query,
            &with_filter(r#"{"term": "", "limit": 3}"#, &filter),
        ));
    }
    operations
}

fn filter_spec(data: &Dataset, operations: Vec<Operation>) -> FilterSpec {
    FilterSpec {
        index: INDEX_NAME.to_string(),
        config: reference_config(PARTITIONS),
        engine: Map::new(),
        writes: writes(data),
        operations,
    }
}

#[test]
fn filtered_queries_listings_and_counts_answer_exactly_as_the_reference_does() {
    let data = dataset();
    let spec = filter_spec(&data, filtered_operations(&data));
    let wanted = reference(&spec);
    let answered = hits_answered(&wanted.outcomes);
    assert!(
        answered >= 150,
        "only {answered} reference operations return hits"
    );
    let found = crate_outcomes(&spec, crate_config(PARTITIONS));
    require_same(&spec, &found, &wanted.outcomes);
}

#[test]
fn malformed_filters_fail_with_the_reference_errors() {
    let data = dataset();
    let spec = filter_spec(&data, hostile_operations());
    let wanted = reference(&spec);
    let found = crate_outcomes(&spec, crate_config(PARTITIONS));
    require_same(&spec, &found, &wanted.outcomes);
}

fn stored_value<'a>(document: &'a Map, field: &str) -> Option<&'a Value> {
    document.get(field)
}

fn oracle_ids(documents: &[Map], keep: impl Fn(&Map) -> bool) -> BTreeSet<String> {
    documents
        .iter()
        .filter(|document| keep(document))
        .filter_map(|document| {
            document
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect()
}

fn live_documents(data: &Dataset) -> Vec<Map> {
    let mut documents = data.documents.clone();
    for &row in &UPDATED_ROWS {
        documents[row] = updated_document(row, &data.documents);
    }
    let removed: BTreeSet<usize> = REMOVED_ROWS.into_iter().collect();
    documents
        .into_iter()
        .enumerate()
        .filter(|(row, _)| !removed.contains(row))
        .map(|(_, document)| document)
        .collect()
}

fn listed_ids(outcome: &Outcome) -> BTreeSet<String> {
    match outcome {
        Outcome::Hits { hits, count, .. } => {
            assert_eq!(
                *count as usize,
                hits.len(),
                "the listing total counts every listed document"
            );
            hits.iter().map(|(id, _)| id.clone()).collect()
        }
        Outcome::Error { code, message } => panic!("the listing failed with {code}: {message}"),
    }
}

#[test]
fn filtered_listings_return_exactly_the_documents_an_independent_scan_keeps() {
    let data = dataset();
    let live = live_documents(&data);
    let number =
        |document: &Map, field: &str| stored_value(document, field).and_then(Value::as_f64);
    let text = |document: &Map, field: &str| {
        stored_value(document, field)
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let list = |document: &Map, field: &str| match stored_value(document, field) {
        Some(Value::Array(items)) => Some(items.clone()),
        _ => None,
    };
    let cases: Vec<(&str, BTreeSet<String>)> = vec![
        (
            FILTERS[1],
            oracle_ids(&live, |d| {
                number(d, "year").is_some_and(|y| (2000.0..2010.0).contains(&y))
            }),
        ),
        (
            FILTERS[7],
            oracle_ids(&live, |d| text(d, "category").is_some_and(|c| c != "tax")),
        ),
        (
            FILTERS[14],
            oracle_ids(&live, |d| {
                list(d, "tags").is_some_and(|tags| {
                    ["health", "defence"]
                        .iter()
                        .all(|want| tags.iter().any(|tag| tag.as_str() == Some(want)))
                })
            }),
        ),
        (
            FILTERS[17],
            oracle_ids(&live, |d| {
                list(d, "tags").is_none_or(|tags| tags.is_empty())
            }),
        ),
        (
            FILTERS[26],
            oracle_ids(&live, |d| !d.contains_key("active")),
        ),
        (
            FILTERS[33],
            oracle_ids(&live, |d| {
                text(d, "code").is_some_and(|c| c.starts_with("HR-"))
            }),
        ),
        (
            FILTERS[49],
            oracle_ids(&live, |d| {
                !text(d, "category").is_some_and(|c| c == "tax" || c == "health")
            }),
        ),
    ];
    let operations = cases
        .iter()
        .map(|(filter, _)| operation(Kind::ListAll, &with_filter(r#"{"limit": 400}"#, filter)))
        .collect();
    let spec = filter_spec(&data, operations);
    let found = crate_outcomes(&spec, crate_config(PARTITIONS));
    for ((filter, wanted), outcome) in cases.iter().zip(&found) {
        assert!(
            !wanted.is_empty(),
            "the oracle keeps documents for {filter}"
        );
        assert_eq!(&listed_ids(outcome), wanted, "the listing for {filter}");
    }
}

const SCORED_TERMS: [&str; 5] = [
    "tax",
    "energy security",
    "health insurance coverage",
    "\"internal revenue code\"",
    "veterans affairs",
];

fn scored_query(term: &str, extra: &str, limit: usize) -> String {
    format!(
        r#"{{"term": "{}", "limit": {limit}, "includeScores": true{extra}}}"#,
        term.replace('"', "\\\"")
    )
}

fn scoring_operations() -> Vec<Operation> {
    let mut operations = Vec::new();
    for term in SCORED_TERMS {
        for extra in [
            "",
            r#", "scoring": "local""#,
            r#", "scoring": "dfs""#,
            r#", "scoring": "broadcast""#,
        ] {
            operations.push(operation(Kind::Query, &scored_query(term, extra, 20)));
            let filtered = with_filter(&scored_query(term, extra, 20), FILTERS[6]);
            operations.push(operation(Kind::Query, &filtered));
        }
    }
    operations
}

#[test]
fn every_scoring_mode_scores_several_partitions_as_the_reference_does() {
    let data = dataset();
    let spec = filter_spec(&data, scoring_operations());
    let wanted = reference(&spec);
    assert!(
        hits_answered(&wanted.outcomes) >= 30,
        "the scored queries return hits"
    );
    let found = crate_outcomes(&spec, crate_config(PARTITIONS));
    require_same(&spec, &found, &wanted.outcomes);
    let mut dfs_default = filter_spec(&data, scoring_operations());
    dfs_default
        .config
        .insert("defaultScoring", Value::String("dfs".into()));
    let wanted = reference(&dfs_default);
    let config = IndexConfig {
        default_scoring: Some(ScoringMode::Dfs),
        ..crate_config(PARTITIONS)
    };
    let found = crate_outcomes(&dfs_default, config);
    require_same(&dfs_default, &found, &wanted.outcomes);
}

fn scored_hits(outcome: &Outcome) -> BTreeSet<(String, Option<u64>)> {
    match outcome {
        Outcome::Hits { hits, .. } => hits.iter().cloned().collect(),
        Outcome::Error { code, message } => panic!("the query failed with {code}: {message}"),
    }
}

#[test]
fn dfs_on_several_partitions_scores_every_document_as_one_partition_does() {
    let data = dataset();
    let operations = SCORED_TERMS
        .iter()
        .map(|term| {
            operation(
                Kind::Query,
                &scored_query(term, r#", "scoring": "dfs""#, ROWS),
            )
        })
        .collect();
    let spec = filter_spec(&data, operations);
    let spread = crate_outcomes(&spec, crate_config(PARTITIONS));
    let single = crate_outcomes(&spec, crate_config(1));
    for ((term, spread), single) in SCORED_TERMS.iter().zip(&spread).zip(&single) {
        let spread = scored_hits(spread);
        assert!(!spread.is_empty(), "{term} matches documents");
        assert_eq!(spread, scored_hits(single), "the dfs scores of {term}");
    }
}

#[test]
fn a_sorted_query_reports_scores_only_when_the_caller_asks_for_them() {
    let data = dataset();
    let sort = r#", "sort": [{"field": "year", "direction": "desc"}]"#;
    let unscored = format!(r#"{{"term": "tax", "limit": 20{sort}}}"#);
    let declined = format!(r#"{{"term": "tax", "limit": 20, "includeScores": false{sort}}}"#);
    let scored = format!(r#"{{"term": "tax", "limit": 20, "includeScores": true{sort}}}"#);
    let operations = vec![
        operation(Kind::Query, &unscored),
        operation(Kind::Query, &declined),
        operation(Kind::Query, &scored),
    ];
    let spec = filter_spec(&data, operations);
    let found = crate_outcomes(&spec, crate_config(PARTITIONS));
    let scores = |outcome: &Outcome| match outcome {
        Outcome::Hits { hits, .. } => {
            assert!(!hits.is_empty(), "the sorted query returns hits");
            hits.iter()
                .map(|(_, score)| score.is_some())
                .collect::<Vec<bool>>()
        }
        Outcome::Error { code, message } => panic!("the query failed with {code}: {message}"),
    };
    assert!(
        scores(&found[0]).iter().all(|kept| !kept),
        "no scores without includeScores"
    );
    assert!(
        scores(&found[1]).iter().all(|kept| !kept),
        "no scores with includeScores false"
    );
    assert!(
        scores(&found[2]).iter().all(|kept| *kept),
        "scores with includeScores true"
    );
}

fn durable_config(root: &Path) -> NarsilConfig {
    NarsilConfig {
        durability: Some(DurabilityConfig {
            directory: Some(root.to_path_buf()),
            mode: Some(DurabilityMode::Sync),
            ..DurabilityConfig::default()
        }),
        ..NarsilConfig::default()
    }
}

fn disk_config() -> IndexConfig {
    let base = crate_config(PARTITIONS);
    IndexConfig {
        text_storage: Some(Storage::Disk),
        vector_promotion: Some(VectorPromotion {
            storage: Some(Storage::Disk),
            ..base.vector_promotion.unwrap_or_default()
        }),
        ..base
    }
}

#[test]
fn filters_on_paged_segments_and_disk_vectors_answer_as_the_reference_does() {
    let data = dataset();
    let operations: Vec<Operation> = filtered_operations(&data)
        .into_iter()
        .filter(|operation| operation.kind != Kind::Preflight)
        .collect();
    let spec = filter_spec(&data, operations);
    let wanted = reference(&spec);
    let scratch = ScratchDirectory::new("filters-paged");
    {
        let engine = Narsil::open(durable_config(scratch.path())).expect("the engine opens");
        engine
            .create_index(INDEX_NAME, disk_config())
            .expect("the index is created");
        apply_writes(&engine, &spec);
        engine
            .checkpoint(INDEX_NAME)
            .expect("the checkpoint is written");
        engine.shutdown().expect("the engine shuts down");
    }
    let engine = Narsil::open(durable_config(scratch.path())).expect("the engine reopens");
    let found = engine_outcomes(&engine, &spec);
    require_same(&spec, &found, &wanted.outcomes);
    engine.shutdown().expect("the engine shuts down");
}

#[test]
fn the_pattern_work_cap_stops_a_filter_and_refuses_bad_settings_as_the_reference_does() {
    let data = dataset();
    let operations = vec![
        operation(Kind::Query, &with_filter(r#"{"term": "tax"}"#, FILTERS[37])),
        operation(
            Kind::ListAll,
            &with_filter(r#"{"limit": 100}"#, FILTERS[35]),
        ),
        operation(Kind::Query, &with_filter(r#"{"term": "tax"}"#, FILTERS[1])),
        operation(
            Kind::Query,
            r#"{"term": "\"internal revenue code\" \"secretary of the treasury\""}"#,
        ),
    ];
    let mut spec = filter_spec(&data, operations);
    spec.engine.insert(
        "patternWorkCap",
        Value::Number(SMALL_PATTERN_WORK_CAP as f64),
    );
    let wanted = reference(&spec);
    let capped = NarsilConfig {
        pattern_work_cap: Some(SMALL_PATTERN_WORK_CAP),
        ..NarsilConfig::default()
    };
    let engine = Narsil::open(capped).expect("the engine opens");
    engine
        .create_index(INDEX_NAME, crate_config(PARTITIONS))
        .expect("the index is created");
    apply_writes(&engine, &spec);
    let found = engine_outcomes(&engine, &spec);
    require_same(&spec, &found, &wanted.outcomes);
    assert!(
        found.iter().any(|outcome| matches!(outcome, Outcome::Error { code, .. } if code == "SEARCH_WORK_CAP_EXCEEDED")),
        "a small cap stops a pattern filter"
    );
    for cap in [0u64, 9_007_199_254_740_992] {
        let mut refused = FilterSpec {
            operations: Vec::new(),
            writes: Vec::new(),
            ..filter_spec(&data, Vec::new())
        };
        refused
            .engine
            .insert("patternWorkCap", Value::Number(cap as f64));
        let wanted = reference(&refused)
            .refused
            .expect("the reference refuses the cap");
        let config = NarsilConfig {
            pattern_work_cap: Some(cap),
            ..NarsilConfig::default()
        };
        let found = match Narsil::open(config) {
            Ok(_) => panic!("the crate opened with a pattern work cap of {cap}"),
            Err(error) => Outcome::Error {
                code: error.code().to_string(),
                message: error.message().to_string(),
            },
        };
        assert_eq!(found, wanted, "the refusal of a cap of {cap}");
    }
}
