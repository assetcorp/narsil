use std::process::Command;

use narsil::{IndexConfig, Map, Narsil, PartitionConfig, Value, parse_json, write_json};

use super::parity::{INSERT_BATCH_DOCUMENTS, dataset_documents};
use super::shaping_compare::normalised_page;
use super::shaping_json::{page_value, shaping_params};
use super::{ScratchDirectory, repository_root};

pub const SHAPING_SCHEMA: &str = r#"{
    "title": "string:sortable",
    "summary": "string:partial",
    "year": "number",
    "pages": "number[]",
    "chamber": "enum",
    "topics": "enum[]",
    "enacted": "boolean",
    "votes": "boolean[]",
    "code": "verbatim:sortable",
    "sponsor": {"rank": "number", "name": "verbatim:sortable"}
}"#;

const CHAMBERS: [&str; 3] = ["house", "senate", "joint"];
const TOPICS: [&str; 5] = ["tax", "health", "education", "energy", "defence"];
const CODES: [&str; 15] = [
    "alpha",
    "Alpha",
    "ÄLPHA",
    "straße",
    "STRASSE",
    "Zeta",
    "zeta",
    "ǅemal",
    "émile",
    "Emile",
    "10",
    "9",
    "e\u{301}mile alpha",
    "İstanbul alpha Alpha",
    "ΣΟΦΟΣ alpha",
];
const LONG_CODE_EVERY: u64 = 997;
const LONG_CODE_CODE_POINTS: usize = 600;

pub struct ShapingSpec {
    pub index: String,
    pub max_partitions: Option<u64>,
    pub late_documents: Vec<Map>,
    pub removals: Vec<String>,
    pub updates: Vec<(String, Map)>,
    pub queries: Vec<(Value, usize)>,
}

fn mixed(seed: u64) -> u64 {
    let mut value = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
    value = (value ^ (value >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    value ^ (value >> 31)
}

fn number(value: u64) -> Value {
    Value::Number(value as f64)
}

fn text(value: &str) -> Value {
    Value::String(value.to_string())
}

fn code_of(at: u64, hash: u64) -> String {
    if at % LONG_CODE_EVERY == 5 {
        let mut code = "w".repeat(LONG_CODE_CODE_POINTS);
        code.push_str(&format!("{}", hash % 7));
        return code;
    }
    CODES[(hash % CODES.len() as u64) as usize].to_string()
}

fn undeclared_note(at: u64, hash: u64) -> Option<Value> {
    match at % 9 {
        0 => None,
        1 => Some(Value::Null),
        2 => Some(text(if hash % 2 == 0 { "a" } else { "b" })),
        3 => Some(number(hash % 4)),
        4 => Some(Value::Array(vec![
            text("x"),
            number(1),
            Value::Null,
            Value::Bool(true),
            text("x"),
        ])),
        5 => Some(Value::Bool(hash % 2 == 0)),
        6 => Some(Value::Array(Vec::new())),
        _ => Some(text("1")),
    }
}

fn undeclared_weight(at: u64, hash: u64) -> Option<Value> {
    match at % 7 {
        0 => None,
        1 => Some(text(" 12 ")),
        2 => Some(text("0x10")),
        3 => Some(Value::Array(vec![number(hash % 30), text("25")])),
        4 => Some(Value::Number((hash % 400) as f64 / 8.0)),
        5 => Some(Value::Bool(true)),
        _ => Some(number(hash % 50)),
    }
}

pub fn augment(document: &mut Map, at: u64) {
    let hash = mixed(at);
    document.remove("embedding");
    if at % 23 != 0 {
        document.insert("year", number(1970 + hash % 50));
    }
    if at % 11 != 0 {
        let count = if at % 11 == 1 { 0 } else { 1 + (hash >> 8) % 3 };
        let pages = (0..count)
            .map(|place| Value::Number((mixed(hash + place) % 1600) as f64 / 4.0))
            .collect();
        document.insert("pages", Value::Array(pages));
    }
    if at % 29 != 0 {
        document.insert("chamber", text(CHAMBERS[(hash % 3) as usize]));
    }
    let topics = (0..(hash >> 12) % 4)
        .map(|place| text(TOPICS[(mixed(hash ^ place) % TOPICS.len() as u64) as usize]))
        .collect();
    document.insert("topics", Value::Array(topics));
    if at % 31 != 0 {
        document.insert("enacted", Value::Bool(hash % 5 == 0));
    }
    let votes = (0..(hash >> 20) % 3)
        .map(|place| Value::Bool((hash >> place) % 2 == 0))
        .collect();
    document.insert("votes", Value::Array(votes));
    document.insert("code", Value::String(code_of(at, hash)));
    if at % 19 != 0 {
        let mut sponsor = Map::new();
        sponsor.insert("rank", number((hash >> 4) % 7));
        sponsor.insert(
            "name",
            text(CODES[((hash >> 6) % CODES.len() as u64) as usize]),
        );
        document.insert("sponsor", Value::Object(sponsor));
    }
    if let Some(note) = undeclared_note(at, hash) {
        document.insert("note", note);
    }
    if let Some(weight) = undeclared_weight(at, hash) {
        document.insert("weight", weight);
    }
}

pub fn shaping_documents(copies: usize) -> Vec<Map> {
    let dataset = dataset_documents();
    let mut documents = Vec::with_capacity(dataset.len() * copies);
    for copy in 0..copies {
        for source in &dataset {
            let at = documents.len() as u64;
            let mut document = source.clone();
            if copy > 0 {
                let id = document
                    .get("id")
                    .and_then(Value::as_str)
                    .expect("each document has an id")
                    .to_string();
                document.insert("id", Value::String(format!("{id}-{copy}")));
            }
            augment(&mut document, at);
            documents.push(document);
        }
    }
    documents
}

pub fn shaping_config(max_partitions: Option<u64>) -> IndexConfig {
    IndexConfig {
        schema: parse_json(SHAPING_SCHEMA).expect("the schema is JSON"),
        language: Some("english".to_string()),
        partitions: max_partitions.map(|max_partitions| PartitionConfig {
            max_partitions: Some(max_partitions),
            ..PartitionConfig::default()
        }),
        ..IndexConfig::default()
    }
}

fn object(entries: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    for (key, value) in entries {
        map.insert(key, value);
    }
    Value::Object(map)
}

fn reference_config(spec: &ShapingSpec) -> Value {
    let mut entries = vec![
        (
            "schema",
            parse_json(SHAPING_SCHEMA).expect("the schema is JSON"),
        ),
        ("language", text("english")),
    ];
    if let Some(max_partitions) = spec.max_partitions {
        entries.push((
            "partitions",
            object(vec![("maxPartitions", number(max_partitions))]),
        ));
    }
    object(entries)
}

fn spec_json(spec: &ShapingSpec, documents_path: &std::path::Path) -> String {
    let updates = spec
        .updates
        .iter()
        .map(|(id, document)| Value::Array(vec![text(id), Value::Object(document.clone())]))
        .collect();
    let queries = spec
        .queries
        .iter()
        .map(|(params, pages)| {
            object(vec![
                ("params", params.clone()),
                ("pages", number(*pages as u64)),
            ])
        })
        .collect();
    write_json(&object(vec![
        ("index", text(&spec.index)),
        ("batch", number(INSERT_BATCH_DOCUMENTS as u64)),
        ("config", reference_config(spec)),
        ("documentsPath", text(&documents_path.to_string_lossy())),
        (
            "lateDocuments",
            Value::Array(
                spec.late_documents
                    .iter()
                    .map(|document| Value::Object(document.clone()))
                    .collect(),
            ),
        ),
        (
            "removals",
            Value::Array(spec.removals.iter().map(|id| text(id)).collect()),
        ),
        ("updates", Value::Array(updates)),
        ("queries", Value::Array(queries)),
    ]))
}

pub fn reference_pages(spec: &ShapingSpec, documents: &[Map]) -> Vec<Vec<Value>> {
    let scratch = ScratchDirectory::new("shaping");
    let documents_path = scratch.path().join("documents.jsonl");
    let lines: Vec<String> = documents
        .iter()
        .map(|document| write_json(&Value::Object(document.clone())))
        .collect();
    std::fs::write(&documents_path, lines.join("\n")).expect("the documents are written");
    let spec_path = scratch.path().join("spec.json");
    std::fs::write(&spec_path, spec_json(spec, &documents_path)).expect("the spec is written");
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/support/reference_shaping.mjs");
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
    found
        .pointer("results")
        .and_then(Value::as_array)
        .expect("the reference lists its results")
        .iter()
        .map(|pages| {
            let mut pages = pages.as_array().expect("a list of pages").clone();
            pages.iter_mut().for_each(normalised_page);
            pages
        })
        .collect()
}

fn error_value(error: &narsil::NarsilError) -> Value {
    object(vec![(
        "error",
        object(vec![
            ("code", text(&error.code().to_string())),
            ("message", text(error.message())),
        ]),
    )])
}

pub fn crate_engine(spec: &ShapingSpec, documents: &[Map]) -> Narsil {
    let engine = Narsil::new();
    engine
        .create_index(&spec.index, shaping_config(spec.max_partitions))
        .expect("the index is created");
    for batch in documents.chunks(INSERT_BATCH_DOCUMENTS) {
        let result = engine
            .insert_batch(&spec.index, batch.to_vec())
            .expect("the batch is inserted");
        assert!(
            result.failed.is_empty(),
            "the crate refused {:?}",
            result.failed
        );
    }
    for (query, _) in &spec.queries {
        let _ = engine.query(&spec.index, &shaping_params(query));
    }
    let late = engine
        .insert_batch(&spec.index, spec.late_documents.clone())
        .expect("the late documents are inserted");
    assert!(
        late.failed.is_empty(),
        "the crate refused {:?}",
        late.failed
    );
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
    engine
}

fn next_page_query(query: &Value) -> Value {
    let mut merged = query.as_object().cloned().unwrap_or_default();
    let overrides = merged.remove("$next");
    if let Some(Value::Object(overrides)) = overrides {
        for (key, value) in overrides.iter() {
            merged.insert(key.clone(), value.clone());
        }
    }
    Value::Object(merged)
}

pub fn crate_pages(spec: &ShapingSpec, engine: &Narsil) -> Vec<Vec<Value>> {
    spec.queries
        .iter()
        .map(|(query, pages)| {
            let mut params = shaping_params(query);
            let mut found = Vec::new();
            for _ in 0..*pages {
                match engine.query(&spec.index, &params) {
                    Ok(result) => {
                        let cursor = result.cursor.clone();
                        found.push(page_value(&result));
                        let Some(cursor) = cursor else { break };
                        params = shaping_params(&next_page_query(query));
                        params.search_after = Some(cursor);
                    }
                    Err(error) => {
                        found.push(error_value(&error));
                        break;
                    }
                }
            }
            found
        })
        .collect()
}
