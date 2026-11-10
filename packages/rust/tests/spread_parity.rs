mod support;

use std::process::Command;

use narsil::{Map, Narsil, ScoringMode, Value, parse_json, write_json};
use support::parity::{
    INSERT_BATCH_DOCUMENTS, Outcome, conformance_searches, dataset_documents, query_params,
};
use support::parity_cases::{index_config, query};
use support::{ScratchDirectory, repository_root};

const INDEX_NAME: &str = "bills";
const PARTITIONS: f64 = 4.0;
const COPIES: usize = 3;

fn copied_documents() -> Vec<Map> {
    let documents = dataset_documents();
    let mut copied = Vec::with_capacity(documents.len() * COPIES);
    for copy in 0..COPIES {
        for document in &documents {
            let mut held = document.clone();
            if copy > 0 {
                let id = held
                    .get("id")
                    .and_then(Value::as_str)
                    .expect("each document has an id")
                    .to_string();
                held.insert("id", Value::String(format!("{id}-{copy}")));
            }
            copied.push(held);
        }
    }
    copied
}

fn queries(searches: &Value) -> Vec<Value> {
    let texts: Vec<String> = searches
        .pointer("text.queries")
        .and_then(Value::as_array)
        .expect("the text queries")
        .iter()
        .map(|entry| {
            entry
                .pointer("text")
                .and_then(Value::as_str)
                .expect("a query text")
                .to_string()
        })
        .collect();
    let mut queries: Vec<Value> = Vec::new();
    for (at, text) in texts.iter().enumerate() {
        let mut map = Map::new();
        map.insert("term", Value::String(text.clone()));
        map.insert("limit", Value::Number(10.0));
        if at % 4 == 1 {
            map.insert("scoring", Value::String("dfs".into()));
        }
        queries.push(Value::Object(map));
    }
    queries.extend([
        query(r#"{"term": "\"internal revenue code\" amend", "limit": 50}"#),
        query(r#"{"term": "amend tax credit", "termMatch": "all", "limit": 200}"#),
        query(r#"{"term": "amnd capitl gains", "tolerance": 1, "limit": 30}"#),
        query(r#"{"term": "educat", "prefix": true, "limit": 30}"#),
        query(r#"{"term": "energy", "minScore": 4, "limit": 500}"#),
        query(r#"{"term": "health care", "offset": 40, "limit": 25}"#),
        query(r#"{"term": "water resources", "fields": ["title"], "limit": 40}"#),
        query(r#"{"term": "veterans benefits", "scoring": "dfs", "limit": 100}"#),
    ]);
    queries
}

fn reference_spec(config: &Map, queries: &[Value]) -> String {
    let mut spec = Map::new();
    spec.insert("index", Value::String(INDEX_NAME.into()));
    spec.insert("batch", Value::Number(INSERT_BATCH_DOCUMENTS as f64));
    spec.insert("config", Value::Object(config.clone()));
    spec.insert("removals", Value::Array(Vec::new()));
    spec.insert("updates", Value::Array(Vec::new()));
    spec.insert("synonymUpdates", Value::Array(Vec::new()));
    spec.insert("queries", Value::Array(queries.to_vec()));
    spec.insert("copies", Value::Number(COPIES as f64));
    write_json(&Value::Object(spec))
}

fn outcome_of(result: &Value) -> Outcome {
    if let Some(error) = result.pointer("error") {
        let text = |name: &str| {
            error
                .pointer(name)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        return Outcome::Error {
            code: text("code"),
            message: text("message"),
        };
    }
    let hits = result
        .pointer("hits")
        .and_then(Value::as_array)
        .expect("the hits")
        .iter()
        .map(|hit| {
            (
                hit.pointer("id")
                    .and_then(Value::as_str)
                    .expect("a hit id")
                    .to_string(),
                hit.pointer("score")
                    .and_then(Value::as_f64)
                    .map(f64::to_bits),
            )
        })
        .collect();
    Outcome::Hits {
        count: result
            .pointer("count")
            .and_then(Value::as_f64)
            .expect("a count") as u64,
        hits,
    }
}

fn reference_outcomes(config: &Map, queries: &[Value]) -> Vec<Outcome> {
    let scratch = ScratchDirectory::new("spread-parity");
    let spec_path = scratch.path().join("spec.json");
    std::fs::write(&spec_path, reference_spec(config, queries)).expect("the spec is written");
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/support/reference_queries.mjs");
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
    parse_json(&text)
        .expect("the reference writes JSON")
        .pointer("results")
        .and_then(Value::as_array)
        .expect("the reference lists its results")
        .iter()
        .map(outcome_of)
        .collect()
}

fn crate_outcome(engine: &Narsil, query: &Value) -> Outcome {
    let mut params = query_params(query);
    if query.pointer("scoring").and_then(Value::as_str) == Some("dfs") {
        params.scoring = Some(ScoringMode::Dfs);
    }
    match engine.query(INDEX_NAME, &params) {
        Ok(result) => Outcome::Hits {
            count: result.count,
            hits: result
                .hits
                .iter()
                .map(|hit| (hit.id.clone(), hit.score.map(f64::to_bits)))
                .collect(),
        },
        Err(error) => Outcome::Error {
            code: error.code().to_string(),
            message: error.message().to_string(),
        },
    }
}

#[test]
fn queries_spread_across_partitions_score_as_the_reference_does() {
    let searches = conformance_searches();
    let queries = queries(&searches);
    let mut reference_config = Map::new();
    let mut partitions = Map::new();
    partitions.insert("maxPartitions", Value::Number(PARTITIONS));
    reference_config.insert("partitions", Value::Object(partitions));
    let wanted = reference_outcomes(&reference_config, &queries);

    let mut config = index_config(&searches);
    config.partitions = Some(narsil::PartitionConfig {
        max_partitions: Some(PARTITIONS as u64),
        ..narsil::PartitionConfig::default()
    });
    let engine = Narsil::new();
    engine
        .create_index(INDEX_NAME, config)
        .expect("the index is created");
    for batch in copied_documents().chunks(INSERT_BATCH_DOCUMENTS) {
        let result = engine
            .insert_batch(INDEX_NAME, batch.to_vec())
            .expect("the batch is inserted");
        assert!(
            result.failed.is_empty(),
            "the crate refused {:?}",
            result.failed
        );
    }

    let found: Vec<Outcome> = std::thread::scope(|scope| {
        let threads: Vec<_> = queries
            .chunks(queries.len().div_ceil(4))
            .map(|chunk| {
                let engine = &engine;
                scope.spawn(move || {
                    chunk
                        .iter()
                        .map(|query| crate_outcome(engine, query))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        threads
            .into_iter()
            .flat_map(|thread| thread.join().expect("a query thread finished"))
            .collect()
    });
    assert_eq!(found.len(), wanted.len());
    for (at, (found, wanted)) in found.iter().zip(&wanted).enumerate() {
        assert_eq!(found, wanted, "query {at}: {}", write_json(&queries[at]));
    }
    assert!(
        found
            .iter()
            .all(|outcome| matches!(outcome, Outcome::Hits { .. }))
    );
}
