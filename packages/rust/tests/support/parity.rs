use std::io::Read;
use std::process::Command;

use flate2::read::GzDecoder;
use narsil::{
    IndexConfig, Map, Narsil, QueryParams, SynonymRule, TermMatch, Value, parse_json, write_json,
};

use super::vector_params::vector_params;
use super::{ScratchDirectory, conformance_root, repository_root};

pub const INSERT_BATCH_DOCUMENTS: usize = 500;
pub const DATASET_VECTOR_DIMENSION: usize = 384;
pub const DATASET_VECTOR_FIELD: &str = "embedding";
const FLOAT32_BYTES: usize = 4;

#[derive(Default)]
pub struct ReferenceExtras {
    pub vectors: bool,
    pub embeddings: Vec<(String, Vec<f32>)>,
    pub rerank_adapters: bool,
}

impl ReferenceExtras {
    fn to_entries(&self) -> Vec<(&'static str, Value)> {
        let embeddings = self
            .embeddings
            .iter()
            .map(|(text, vector)| {
                Value::Array(vec![Value::String(text.clone()), vector_value(vector)])
            })
            .collect();
        vec![
            ("vectors", Value::Bool(self.vectors)),
            ("embeddings", Value::Array(embeddings)),
            ("rerankAdapters", Value::Bool(self.rerank_adapters)),
        ]
    }
}

pub fn vector_value(vector: &[f32]) -> Value {
    Value::Array(
        vector
            .iter()
            .map(|element| Value::Number(f64::from(*element)))
            .collect(),
    )
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Hits {
        count: u64,
        hits: Vec<(String, Option<u64>)>,
    },
    Error {
        code: String,
        message: String,
    },
}

pub struct ParitySpec {
    pub index: String,
    pub config: Map,
    pub removals: Vec<String>,
    pub updates: Vec<(String, Map)>,
    pub synonym_updates: Vec<Value>,
    pub queries: Vec<Value>,
}

pub fn synonym_rules(rules: &Value) -> Vec<SynonymRule> {
    rules
        .as_array()
        .expect("a list of synonym rules")
        .iter()
        .map(|rule| match rule.pointer("words") {
            Some(words) => SynonymRule::TwoWay(strings(words)),
            None => SynonymRule::OneWay {
                word: rule
                    .pointer("word")
                    .and_then(Value::as_str)
                    .expect("a word")
                    .to_string(),
                synonyms: strings(rule.pointer("synonyms").expect("the synonyms")),
            },
        })
        .collect()
}

fn outcome_of<T>(result: narsil::Result<T>, hits: impl FnOnce(T) -> Outcome) -> Outcome {
    match result {
        Ok(found) => hits(found),
        Err(error) => Outcome::Error {
            code: error.code().to_string(),
            message: error.message().to_string(),
        },
    }
}

fn object(entries: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    for (key, value) in entries {
        map.insert(key.to_string(), value);
    }
    Value::Object(map)
}

impl ParitySpec {
    fn to_json(&self, extras: &ReferenceExtras) -> String {
        let updates = self
            .updates
            .iter()
            .map(|(id, document)| {
                Value::Array(vec![
                    Value::String(id.clone()),
                    Value::Object(document.clone()),
                ])
            })
            .collect();
        let mut entries = vec![
            ("index", Value::String(self.index.clone())),
            ("batch", Value::Number(INSERT_BATCH_DOCUMENTS as f64)),
            ("config", Value::Object(self.config.clone())),
            (
                "removals",
                Value::Array(self.removals.iter().cloned().map(Value::String).collect()),
            ),
            ("updates", Value::Array(updates)),
            ("synonymUpdates", Value::Array(self.synonym_updates.clone())),
            ("queries", Value::Array(self.queries.clone())),
        ];
        entries.extend(extras.to_entries());
        write_json(&object(entries))
    }

    fn steps(&self) -> impl Iterator<Item = &Value> {
        self.synonym_updates.iter().chain(&self.queries)
    }
}

pub fn conformance_searches() -> Value {
    let path = conformance_root().join("searches/queries.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{} is unreadable: {error}", path.display()));
    parse_json(&text).expect("the searches hold JSON")
}

pub fn dataset_documents() -> Vec<Map> {
    let path = conformance_root().join(".dataset/documents.jsonl.gz");
    let compressed = std::fs::read(&path).unwrap_or_else(|error| {
        panic!(
            "{} is unreadable ({error}); run `node packages/conformance/dist/cli.mjs fetch` first",
            path.display()
        )
    });
    let mut text = String::new();
    GzDecoder::new(compressed.as_slice())
        .read_to_string(&mut text)
        .expect("the documents decompress as UTF-8");
    text.lines()
        .map(|line| {
            let value = parse_json(line).expect("each line holds JSON");
            value
                .as_object()
                .expect("each line holds an object")
                .clone()
        })
        .collect()
}

pub fn dataset_vectors() -> Vec<Vec<f32>> {
    let path = conformance_root().join(".dataset/vectors.f32");
    let bytes = std::fs::read(&path)
        .unwrap_or_else(|error| panic!("{} is unreadable: {error}", path.display()));
    bytes
        .chunks_exact(DATASET_VECTOR_DIMENSION * FLOAT32_BYTES)
        .map(|row| {
            row.chunks_exact(FLOAT32_BYTES)
                .map(|element| f32::from_le_bytes([element[0], element[1], element[2], element[3]]))
                .collect()
        })
        .collect()
}

pub fn dataset_documents_with_vectors() -> Vec<Map> {
    let mut documents = dataset_documents();
    let vectors = dataset_vectors();
    assert_eq!(documents.len(), vectors.len(), "one vector per document");
    for (document, vector) in documents.iter_mut().zip(&vectors) {
        document.insert(DATASET_VECTOR_FIELD, vector_value(vector));
    }
    documents
}

fn outcomes_of(found: &Value) -> Vec<Outcome> {
    let results = found
        .pointer("results")
        .and_then(Value::as_array)
        .expect("the reference lists its results");
    results
        .iter()
        .map(|result| match result.pointer("error") {
            Some(error) => Outcome::Error {
                code: error
                    .pointer("code")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                message: error
                    .pointer("message")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            },
            None => Outcome::Hits {
                count: result
                    .pointer("count")
                    .and_then(Value::as_f64)
                    .expect("a count") as u64,
                hits: result
                    .pointer("hits")
                    .and_then(Value::as_array)
                    .expect("the hits")
                    .iter()
                    .map(|hit| {
                        let id = hit.pointer("id").and_then(Value::as_str).expect("an ID");
                        let score = hit
                            .pointer("score")
                            .and_then(Value::as_f64)
                            .map(f64::to_bits);
                        (id.to_string(), score)
                    })
                    .collect(),
            },
        })
        .collect()
}

pub fn reference_outcomes(spec: &ParitySpec) -> Vec<Outcome> {
    reference_outcomes_with(spec, &ReferenceExtras::default())
}

pub fn reference_outcomes_with(spec: &ParitySpec, extras: &ReferenceExtras) -> Vec<Outcome> {
    let scratch = ScratchDirectory::new("parity");
    let spec_path = scratch.path().join("spec.json");
    std::fs::write(&spec_path, spec.to_json(extras)).expect("the spec is written");
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
    outcomes_of(&parse_json(&text).expect("the reference writes JSON"))
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .expect("a list of strings")
        .iter()
        .map(|item| item.as_str().expect("a string").to_string())
        .collect()
}

fn whole(value: &Value) -> u32 {
    value.as_f64().expect("a number") as u32
}

pub fn query_params(query: &Value) -> QueryParams {
    let field = |name: &str| query.as_object().and_then(|map| map.get(name));
    QueryParams {
        term: field("term").and_then(Value::as_str).map(str::to_string),
        fields: field("fields").map(strings),
        boost: field("boost").map(|boost| {
            let map = boost.as_object().expect("an object of boosts");
            map.iter()
                .map(|(name, value)| (name.clone(), value.as_f64().expect("a boost")))
                .collect()
        }),
        tolerance: field("tolerance").map(whole),
        prefix_length: field("prefixLength").map(whole),
        exact: field("exact").and_then(Value::as_bool),
        prefix: field("prefix").and_then(Value::as_bool),
        partial_words: field("partialWords").and_then(Value::as_bool),
        min_score: field("minScore").and_then(Value::as_f64),
        term_match: field("termMatch").map(|policy| match policy {
            Value::String(text) if text == "all" => TermMatch::All,
            Value::String(text) if text == "any" => TermMatch::Any,
            other => TermMatch::AtLeast(whole(other)),
        }),
        limit: field("limit").map(|limit| whole(limit) as usize),
        offset: field("offset").map(|offset| whole(offset) as usize),
        filters: field("filters").cloned(),
        ..vector_params(query)
    }
}

pub fn crate_outcomes(spec: &ParitySpec, config: IndexConfig) -> Vec<Outcome> {
    let engine = Narsil::new();
    load_engine(&engine, spec, config, &mut |_| {});
    apply_writes(&engine, spec);
    engine_outcomes(&engine, spec)
}

pub fn load_engine(
    engine: &Narsil,
    spec: &ParitySpec,
    config: IndexConfig,
    after_batch: &mut dyn FnMut(usize),
) {
    load_documents(engine, spec, config, &dataset_documents(), after_batch);
}

pub fn load_documents(
    engine: &Narsil,
    spec: &ParitySpec,
    config: IndexConfig,
    documents: &[Map],
    after_batch: &mut dyn FnMut(usize),
) {
    engine
        .create_index(&spec.index, config)
        .expect("the index is created");
    for (at, batch) in documents.chunks(INSERT_BATCH_DOCUMENTS).enumerate() {
        let result = engine
            .insert_batch(&spec.index, batch.to_vec())
            .expect("the batch is inserted");
        assert!(
            result.failed.is_empty(),
            "the crate refused {:?}",
            result.failed
        );
        after_batch(at);
    }
}

pub fn apply_writes(engine: &Narsil, spec: &ParitySpec) {
    for id in &spec.removals {
        engine
            .remove(&spec.index, id)
            .expect("the document is removed");
    }
    for (id, document) in &spec.updates {
        engine
            .update(&spec.index, id, document.clone())
            .expect("the document is updated");
    }
}

pub fn engine_outcomes(engine: &Narsil, spec: &ParitySpec) -> Vec<Outcome> {
    let mut outcomes: Vec<Outcome> = spec
        .synonym_updates
        .iter()
        .map(|rules| {
            outcome_of(
                engine.update_synonyms(&spec.index, &synonym_rules(rules)),
                |()| Outcome::Hits {
                    count: 0,
                    hits: Vec::new(),
                },
            )
        })
        .collect();
    outcomes.extend(spec.queries.iter().map(|query| {
        outcome_of(engine.query(&spec.index, &query_params(query)), |result| {
            Outcome::Hits {
                count: result.count,
                hits: result
                    .hits
                    .into_iter()
                    .map(|hit| (hit.id, hit.score.map(f64::to_bits)))
                    .collect(),
            }
        })
    }));
    outcomes
}

pub fn differences(spec: &ParitySpec, found: &[Outcome], wanted: &[Outcome]) -> Vec<String> {
    assert_eq!(found.len(), wanted.len(), "both sides answer every query");
    spec.steps()
        .zip(found.iter().zip(wanted))
        .filter(|(_, (found, wanted))| found != wanted)
        .map(|(query, (found, wanted))| {
            format!(
                "{}\n  crate:     {found:?}\n  reference: {wanted:?}",
                write_json(query)
            )
        })
        .collect()
}
