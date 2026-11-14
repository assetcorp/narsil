mod support;

use std::io::Read;
use std::process::Command;

use flate2::read::GzDecoder;
use narsil::{GroupConfig, IndexConfig, Map, Narsil, QueryParams, Value, parse_json};
use support::{conformance_root, repository_root};

const INDEX_NAME: &str = "bills";
const INSERT_BATCH_DOCUMENTS: usize = 500;
const SCORE_RELATIVE_TOLERANCE: f64 = 1e-9;

type RankedHits = Vec<(String, f64)>;

struct TextQuery {
    id: String,
    text: String,
}

fn dataset_bytes(path: &std::path::Path) -> Vec<u8> {
    std::fs::read(path).unwrap_or_else(|error| {
        panic!(
            "{} is unreadable ({error}); run `node packages/conformance/dist/cli.mjs fetch` first",
            path.display()
        )
    })
}

fn committed_searches() -> Value {
    let path = conformance_root().join("searches/queries.json");
    let text = String::from_utf8(dataset_bytes(&path)).expect("the searches are UTF-8");
    parse_json(&text).expect("the searches hold JSON")
}

fn dataset_documents() -> Vec<Map> {
    let compressed = dataset_bytes(&conformance_root().join(".dataset/documents.jsonl.gz"));
    let mut text = String::new();
    GzDecoder::new(compressed.as_slice())
        .read_to_string(&mut text)
        .expect("the documents decompress as UTF-8");
    text.lines()
        .map(|line| {
            parse_json(line)
                .expect("each line holds JSON")
                .as_object()
                .expect("each line holds an object")
                .clone()
        })
        .collect()
}

fn listed<'a>(value: &'a Value, path: &str) -> &'a [Value] {
    value
        .pointer(path)
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("the JSON lists {path}"))
}

fn text_of<'a>(value: &'a Value, path: &str) -> &'a str {
    value
        .pointer(path)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("the JSON holds a string at {path}"))
}

fn text_queries(searches: &Value) -> Vec<TextQuery> {
    listed(searches, "text.queries")
        .iter()
        .map(|query| TextQuery {
            id: text_of(query, "id").to_string(),
            text: text_of(query, "text").to_string(),
        })
        .collect()
}

fn ranked_hits(queries: &[Value]) -> Vec<(String, RankedHits)> {
    queries
        .iter()
        .map(|query| {
            let hits = listed(query, "hits")
                .iter()
                .map(|hit| {
                    let score = hit.pointer("score").and_then(Value::as_f64);
                    (
                        text_of(hit, "id").to_string(),
                        score.expect("each hit carries a score"),
                    )
                })
                .collect();
            (text_of(query, "id").to_string(), hits)
        })
        .collect()
}

fn reference_hits() -> Vec<(String, RankedHits)> {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/support/reference_text_scores.mjs");
    let output = Command::new("node")
        .arg(script)
        .arg(repository_root())
        .arg(INDEX_NAME)
        .arg(INSERT_BATCH_DOCUMENTS.to_string())
        .output()
        .expect("node runs the TypeScript reference");
    assert!(
        output.status.success(),
        "the TypeScript reference failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout).expect("the reference writes UTF-8");
    let found = parse_json(&text).expect("the reference writes JSON");
    ranked_hits(listed(&found, "queries"))
}

fn filled_engine(searches: &Value) -> Narsil {
    let engine = Narsil::new();
    let config = IndexConfig {
        schema: searches.pointer("index.schema").cloned().expect("a schema"),
        language: Some(text_of(searches, "index.language").to_string()),
        ..IndexConfig::default()
    };
    engine
        .create_index(INDEX_NAME, config)
        .expect("the index is created");
    let documents = dataset_documents();
    assert_eq!(
        documents.len(),
        10_000,
        "the pinned dataset holds 10,000 documents"
    );
    for batch in documents.chunks(INSERT_BATCH_DOCUMENTS) {
        let result = engine
            .insert_batch(INDEX_NAME, batch.to_vec())
            .expect("the batch is inserted");
        assert!(
            result.failed.is_empty(),
            "the engine refused {:?}",
            result.failed
        );
    }
    engine
}

fn crate_hits(searches: &Value) -> Vec<(String, RankedHits)> {
    let limit = searches
        .pointer("text.limit")
        .and_then(Value::as_f64)
        .expect("a text limit") as usize;
    let engine = filled_engine(searches);
    let queries = text_queries(searches);
    assert!(
        !queries.is_empty(),
        "the searches list at least one text query"
    );
    queries
        .into_iter()
        .map(|query| {
            let params = QueryParams {
                term: Some(query.text),
                limit: Some(limit),
                ..QueryParams::default()
            };
            let result = engine.query(INDEX_NAME, &params).expect("the query runs");
            let hits = result
                .hits
                .into_iter()
                .map(|hit| (hit.id, hit.score.expect("each hit carries a score")))
                .collect();
            (query.id, hits)
        })
        .collect()
}

fn differences(
    found: &[(String, RankedHits)],
    wanted: &[(String, RankedHits)],
    same_score: impl Fn(f64, f64) -> bool,
) -> Vec<String> {
    assert_eq!(found.len(), wanted.len(), "both sides answer every query");
    let mut problems = Vec::new();
    for ((id, hits), (wanted_id, wanted_hits)) in found.iter().zip(wanted) {
        assert_eq!(id, wanted_id, "both sides answer the queries in one order");
        let ids: Vec<&str> = hits.iter().map(|(hit, _)| hit.as_str()).collect();
        let wanted_ids: Vec<&str> = wanted_hits.iter().map(|(hit, _)| hit.as_str()).collect();
        if ids != wanted_ids {
            problems.push(format!("{id}: found {ids:?}, wanted {wanted_ids:?}"));
            continue;
        }
        for ((hit, score), (_, wanted_score)) in hits.iter().zip(wanted_hits) {
            if !same_score(*score, *wanted_score) {
                problems.push(format!(
                    "{id}: {hit} scored {score:e}, wanted {wanted_score:e}"
                ));
            }
        }
    }
    problems
}

fn within_suite_tolerance(found: f64, wanted: f64) -> bool {
    (found - wanted).abs() <= SCORE_RELATIVE_TOLERANCE * wanted.abs().max(1.0)
}

fn whole_number(value: &Value, path: &str) -> usize {
    value
        .pointer(path)
        .and_then(Value::as_f64)
        .unwrap_or_else(|| panic!("the JSON holds a number at {path}")) as usize
}

fn committed_group_config(searches: &Value) -> GroupConfig {
    GroupConfig {
        fields: listed(searches, "grouped.group.fields")
            .iter()
            .map(|field| field.as_str().expect("each field is a string").to_string())
            .collect(),
        max_per_group: Some(whole_number(searches, "grouped.group.maxPerGroup")),
        limit: Some(whole_number(searches, "grouped.group.limit")),
        reduce: None,
    }
}

fn group_differences(engine: &Narsil, searches: &Value) -> Vec<String> {
    let limit = whole_number(searches, "text.limit");
    let config = committed_group_config(searches);
    let mut problems = Vec::new();
    for query in listed(searches, "grouped.queries") {
        let id = text_of(query, "id");
        let params = QueryParams {
            term: Some(text_of(query, "text").to_string()),
            limit: Some(limit),
            group: Some(config.clone()),
            ..QueryParams::default()
        };
        let result = engine
            .query(INDEX_NAME, &params)
            .expect("the grouped query runs");
        let found: Vec<(Map, Vec<String>)> = result
            .groups
            .unwrap_or_default()
            .into_iter()
            .map(|group| {
                let mut values = Map::new();
                for (field, value) in group.values {
                    values.insert(field, value.unwrap_or(Value::Null));
                }
                (values, group.hits.into_iter().map(|hit| hit.id).collect())
            })
            .collect();
        let wanted: Vec<(Map, Vec<String>)> = listed(query, "groups")
            .iter()
            .map(|group| {
                let values = group
                    .pointer("values")
                    .and_then(Value::as_object)
                    .expect("each group holds its values")
                    .clone();
                let ids = listed(group, "ids")
                    .iter()
                    .map(|hit| hit.as_str().expect("each ID is a string").to_string())
                    .collect();
                (values, ids)
            })
            .collect();
        if found != wanted {
            problems.push(format!("{id}: found {found:?}, wanted {wanted:?}"));
        }
    }
    problems
}

#[test]
fn every_grouped_query_reports_each_grouping_field_as_the_reference_does() {
    let searches = committed_searches();
    let engine = filled_engine(&searches);
    let problems = group_differences(&engine, &searches);
    assert!(
        problems.is_empty(),
        "against the committed groups:\n{}",
        problems.join("\n")
    );
}

#[test]
fn every_text_query_ranks_and_scores_the_pinned_dataset_as_the_reference_does() {
    let searches = committed_searches();
    let found = crate_hits(&searches);
    let committed = ranked_hits(listed(&searches, "text.queries"));
    let reference = reference_hits();
    let against_committed = differences(&found, &committed, within_suite_tolerance);
    let against_reference = differences(&found, &reference, |found, wanted| {
        found.to_bits() == wanted.to_bits()
    });
    assert!(
        against_committed.is_empty() && against_reference.is_empty(),
        "against the committed searches:\n{}\nagainst the TypeScript reference, bit for bit:\n{}",
        against_committed.join("\n"),
        against_reference.join("\n")
    );
}
