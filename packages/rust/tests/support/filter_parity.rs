use std::process::Command;

use narsil::{
    IndexConfig, ListParams, Map, Narsil, QueryParams, ScoringMode, SortDirection, SortField,
    Value, parse_json, write_json,
};

use super::parity::query_params;
use super::{ScratchDirectory, repository_root};

pub enum Write {
    Insert(Vec<Map>),
    Remove(Vec<String>),
    Update(Vec<(String, Map)>),
    Freeze,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Query,
    List,
    ListAll,
    Preflight,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Query => "query",
            Kind::List => "list",
            Kind::ListAll => "listAll",
            Kind::Preflight => "preflight",
        }
    }
}

pub struct Operation {
    pub kind: Kind,
    pub params: Value,
}

pub fn operation(kind: Kind, json: &str) -> Operation {
    Operation {
        kind,
        params: parse_json(json).unwrap_or_else(|error| panic!("{json} is no JSON: {error:?}")),
    }
}

pub struct FilterSpec {
    pub index: String,
    pub config: Map,
    pub engine: Map,
    pub writes: Vec<Write>,
    pub operations: Vec<Operation>,
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Hits {
        count: u64,
        hits: Vec<(String, Option<u64>)>,
        cursor: Option<String>,
    },
    Error {
        code: String,
        message: String,
    },
}

fn object(entries: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    for (key, value) in entries {
        map.insert(key.to_string(), value);
    }
    Value::Object(map)
}

fn write_json_of(write: &Write) -> Value {
    match write {
        Write::Insert(documents) => object(vec![
            ("kind", Value::String("insert".into())),
            (
                "documents",
                Value::Array(documents.iter().cloned().map(Value::Object).collect()),
            ),
        ]),
        Write::Remove(ids) => object(vec![
            ("kind", Value::String("remove".into())),
            (
                "ids",
                Value::Array(ids.iter().cloned().map(Value::String).collect()),
            ),
        ]),
        Write::Update(documents) => object(vec![
            ("kind", Value::String("update".into())),
            (
                "documents",
                Value::Array(
                    documents
                        .iter()
                        .map(|(id, document)| {
                            Value::Array(vec![
                                Value::String(id.clone()),
                                Value::Object(document.clone()),
                            ])
                        })
                        .collect(),
                ),
            ),
        ]),
        Write::Freeze => object(vec![("kind", Value::String("freeze".into()))]),
    }
}

impl FilterSpec {
    fn to_json(&self) -> String {
        let operations = self
            .operations
            .iter()
            .map(|operation| {
                object(vec![
                    ("kind", Value::String(operation.kind.name().into())),
                    ("params", operation.params.clone()),
                ])
            })
            .collect();
        write_json(&object(vec![
            ("index", Value::String(self.index.clone())),
            ("config", Value::Object(self.config.clone())),
            ("engine", Value::Object(self.engine.clone())),
            (
                "writes",
                Value::Array(self.writes.iter().map(write_json_of).collect()),
            ),
            ("operations", Value::Array(operations)),
        ]))
    }
}

fn outcome_of(result: &Value) -> Outcome {
    if let Some(error) = result.pointer("error") {
        return Outcome::Error {
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
        };
    }
    Outcome::Hits {
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
        cursor: result
            .pointer("cursor")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

pub struct Reference {
    pub refused: Option<Outcome>,
    pub outcomes: Vec<Outcome>,
}

pub fn reference(spec: &FilterSpec) -> Reference {
    let scratch = ScratchDirectory::new("filters");
    let spec_path = scratch.path().join("spec.json");
    std::fs::write(&spec_path, spec.to_json()).expect("the spec is written");
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/support/reference_filters.mjs");
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
    let found = parse_json(&text).expect("the reference writes JSON");
    let refused = found.pointer("refused").map(|error| {
        let mut wrapped = Map::new();
        wrapped.insert("error", error.clone());
        outcome_of(&Value::Object(wrapped))
    });
    let outcomes = found
        .pointer("results")
        .and_then(Value::as_array)
        .expect("the reference lists its results")
        .iter()
        .map(outcome_of)
        .collect();
    Reference { refused, outcomes }
}

fn failure(error: narsil::NarsilError) -> Outcome {
    Outcome::Error {
        code: error.code().to_string(),
        message: error.message().to_string(),
    }
}

fn scoring_of(name: &str) -> ScoringMode {
    match name {
        "dfs" => ScoringMode::Dfs,
        "broadcast" => ScoringMode::Broadcast,
        _ => ScoringMode::Local,
    }
}

fn sort_of(value: &Value) -> Vec<SortField> {
    value
        .as_array()
        .expect("a sort is a list")
        .iter()
        .map(|entry| SortField {
            field: entry
                .pointer("field")
                .and_then(Value::as_str)
                .expect("a field")
                .to_string(),
            direction: match entry.pointer("direction").and_then(Value::as_str) {
                Some("desc") => SortDirection::Desc,
                _ => SortDirection::Asc,
            },
            mode: None,
        })
        .collect()
}

pub fn filtered_query_params(value: &Value) -> QueryParams {
    QueryParams {
        filters: value.pointer("filters").cloned(),
        scoring: value
            .pointer("scoring")
            .and_then(Value::as_str)
            .map(scoring_of),
        include_scores: value.pointer("includeScores").and_then(Value::as_bool),
        sort: value.pointer("sort").map(sort_of),
        ..query_params(value)
    }
}

fn list_params(value: &Value) -> ListParams {
    ListParams {
        cursor: value
            .pointer("cursor")
            .and_then(Value::as_str)
            .map(str::to_string),
        limit: value
            .pointer("limit")
            .and_then(Value::as_f64)
            .map(|limit| limit as usize),
        filters: value.pointer("filters").cloned(),
        document: None,
    }
}

fn every_page(engine: &Narsil, index: &str, params: &Value) -> narsil::Result<Outcome> {
    let mut params = list_params(params);
    let mut hits = Vec::new();
    let mut first_cursor = None;
    loop {
        let page = engine.list_documents(index, &params)?;
        hits.extend(
            page.documents
                .into_iter()
                .map(|document| (document.id, None)),
        );
        let Some(cursor) = page.cursor else {
            return Ok(Outcome::Hits {
                count: page.total,
                hits,
                cursor: first_cursor,
            });
        };
        first_cursor.get_or_insert_with(|| cursor.clone());
        params.cursor = Some(cursor);
    }
}

fn answer(engine: &Narsil, index: &str, operation: &Operation) -> narsil::Result<Outcome> {
    match operation.kind {
        Kind::Query => {
            let result = engine.query(index, &filtered_query_params(&operation.params))?;
            Ok(Outcome::Hits {
                count: result.count,
                hits: result
                    .hits
                    .into_iter()
                    .map(|hit| (hit.id, hit.score.map(f64::to_bits)))
                    .collect(),
                cursor: None,
            })
        }
        Kind::Preflight => {
            let counted = engine.preflight(index, &filtered_query_params(&operation.params))?;
            Ok(Outcome::Hits {
                count: counted.count,
                hits: Vec::new(),
                cursor: None,
            })
        }
        Kind::List => {
            let page = engine.list_documents(index, &list_params(&operation.params))?;
            Ok(Outcome::Hits {
                count: page.total,
                hits: page
                    .documents
                    .into_iter()
                    .map(|document| (document.id, None))
                    .collect(),
                cursor: page.cursor,
            })
        }
        Kind::ListAll => every_page(engine, index, &operation.params),
    }
}

pub fn apply_writes(engine: &Narsil, spec: &FilterSpec) {
    for write in &spec.writes {
        match write {
            Write::Insert(documents) => {
                let result = engine
                    .insert_batch(&spec.index, documents.clone())
                    .expect("the batch is inserted");
                assert!(
                    result.failed.is_empty(),
                    "the crate refused {:?}",
                    result.failed
                );
            }
            Write::Remove(ids) => {
                for id in ids {
                    engine
                        .remove(&spec.index, id)
                        .expect("the document is removed");
                }
            }
            Write::Update(documents) => {
                for (id, document) in documents {
                    engine
                        .update(&spec.index, id, document.clone())
                        .expect("the document is updated");
                }
            }
            Write::Freeze => engine
                .freeze_tail_segments(&spec.index)
                .expect("the tails freeze"),
        }
    }
}

pub fn engine_outcomes(engine: &Narsil, spec: &FilterSpec) -> Vec<Outcome> {
    spec.operations
        .iter()
        .map(|operation| answer(engine, &spec.index, operation).unwrap_or_else(failure))
        .collect()
}

pub fn crate_outcomes(spec: &FilterSpec, config: IndexConfig) -> Vec<Outcome> {
    let engine = Narsil::new();
    engine
        .create_index(&spec.index, config)
        .expect("the index is created");
    apply_writes(&engine, spec);
    engine_outcomes(&engine, spec)
}

pub fn require_same(spec: &FilterSpec, found: &[Outcome], wanted: &[Outcome]) {
    assert_eq!(
        found.len(),
        wanted.len(),
        "both sides answer every operation"
    );
    let problems: Vec<String> = spec
        .operations
        .iter()
        .zip(found.iter().zip(wanted))
        .filter(|(_, (found, wanted))| found != wanted)
        .map(|(operation, (found, wanted))| {
            format!(
                "{} {}\n  crate:     {found:?}\n  reference: {wanted:?}",
                operation.kind.name(),
                write_json(&operation.params)
            )
        })
        .collect();
    assert!(
        problems.is_empty(),
        "{} of {} operations differ:\n{}",
        problems.len(),
        found.len(),
        problems.join("\n")
    );
}

pub fn hits_answered(outcomes: &[Outcome]) -> usize {
    outcomes
        .iter()
        .filter(|outcome| matches!(outcome, Outcome::Hits { hits, .. } if !hits.is_empty()))
        .count()
}
