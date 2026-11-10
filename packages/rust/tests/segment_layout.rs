mod support;

use std::path::Path;
use std::process::Command;

use narsil::conformance::read_sample;
use narsil::{IndexConfig, Map, Narsil, Value, parse_json, write_json};
use support::{ScratchDirectory, conformance_root, repository_root};

const PRODUCTS_INDEX: &str = "products";
const LAYOUT_INDEX: &str = "layout";
const SHOWN_CHARACTERS: usize = 600;

fn json(text: &str) -> Value {
    parse_json(text).expect("the value is JSON")
}

fn expected_payload(name: &str) -> Map {
    let path = conformance_root().join(format!("samples/expected/keyword-segment/{name}.json"));
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{} is unreadable: {error}", path.display()));
    json(&text)
        .pointer("payload")
        .and_then(Value::as_object)
        .cloned()
        .expect("the form holds a payload")
}

fn documents_of(payload: &Map) -> Vec<Map> {
    payload
        .get("documents")
        .and_then(Value::as_array)
        .expect("the payload lists its documents")
        .iter()
        .map(|document| {
            document
                .as_object()
                .cloned()
                .expect("each document is an object")
        })
        .collect()
}

fn config_of(schema: &Value) -> IndexConfig {
    IndexConfig {
        schema: schema.clone(),
        language: Some("english".into()),
        track_positions: Some(true),
        surface_forms: Some(true),
        required: Some(vec!["title".into()]),
        ..IndexConfig::default()
    }
}

fn reference_config(schema: &Value) -> Value {
    json(&format!(
        r#"{{"schema": {}, "language": "english", "trackPositions": true, "surfaceForms": true, "required": ["title"]}}"#,
        write_json(schema)
    ))
}

fn payload_of(file: &[u8]) -> Map {
    read_sample("keyword-segment", file, None)
        .expect("the segment file reads back")
        .pointer("payload")
        .and_then(Value::as_object)
        .cloned()
        .expect("the form holds a payload")
}

fn shown(value: Option<&Value>) -> String {
    let text = value.map_or_else(|| "nothing".to_string(), write_json);
    text.chars().take(SHOWN_CHARACTERS).collect()
}

fn require_same_payload(label: &str, found: &Map, wanted: &Map) {
    let mut keys: Vec<&String> = found.keys().chain(wanted.keys()).collect();
    keys.sort();
    keys.dedup();
    let problems: Vec<String> = keys
        .into_iter()
        .filter(|key| key.as_str() != "tombstones" && found.get(key) != wanted.get(key))
        .map(|key| {
            format!(
                "{key}\n  crate:     {}\n  reference: {}",
                shown(found.get(key)),
                shown(wanted.get(key))
            )
        })
        .collect();
    assert!(
        problems.is_empty(),
        "{label}: the payloads differ in {} keys:\n{}",
        problems.len(),
        problems.join("\n")
    );
    assert_eq!(
        found.get("tombstones"),
        Some(&Value::Array(Vec::new())),
        "{label}: a frozen payload holds no tombstones"
    );
}

fn insert_all(engine: &Narsil, index: &str, documents: &[Map]) {
    let result = engine
        .insert_batch(index, documents.to_vec())
        .expect("the batch is inserted");
    assert!(
        result.failed.is_empty(),
        "the crate refused {:?}",
        result.failed
    );
}

fn remove_all(engine: &Narsil, index: &str, ids: &[&str]) {
    for id in ids {
        engine.remove(index, id).expect("the document is removed");
    }
}

fn only_partition(engine: &Narsil, index: &str) -> Vec<Vec<u8>> {
    let mut files = engine
        .keyword_segment_files(index)
        .expect("the segments are written");
    assert_eq!(files.len(), 1, "the index holds one partition");
    files.pop().unwrap_or_default()
}

#[test]
fn frozen_tails_lay_out_their_segments_as_the_reference_sample_does() {
    let first = expected_payload("products-p0-s0");
    let second = expected_payload("products-p0-s1");
    let schema = first
        .get("schema")
        .cloned()
        .expect("the payload holds a schema");
    let engine = Narsil::new();
    engine
        .create_index(PRODUCTS_INDEX, config_of(&schema))
        .expect("the index is created");
    insert_all(&engine, PRODUCTS_INDEX, &documents_of(&first));
    let files = only_partition(&engine, PRODUCTS_INDEX);
    let file = files.first().expect("the partition holds a tail");
    require_same_payload("the first checkpoint", &payload_of(file), &first);
    engine
        .freeze_tail_segments(PRODUCTS_INDEX)
        .expect("the tail freezes");
    insert_all(&engine, PRODUCTS_INDEX, &documents_of(&second));
    remove_all(&engine, PRODUCTS_INDEX, &["product-001"]);
    let files = only_partition(&engine, PRODUCTS_INDEX);
    assert_eq!(files.len(), 2, "a frozen segment and a tail");
    let file = files.get(1).expect("the partition holds a tail");
    require_same_payload("the second checkpoint", &payload_of(file), &second);
}

struct Stage<'a> {
    insert: &'a [Map],
    remove: &'a [&'a str],
}

fn reference_segment_files(index: &str, schema: &Value, stages: &[Stage<'_>]) -> Vec<Vec<u8>> {
    let scratch = ScratchDirectory::new("segments");
    let steps = stages
        .iter()
        .map(|stage| {
            let mut step = Map::new();
            step.insert(
                "insert",
                Value::Array(stage.insert.iter().cloned().map(Value::Object).collect()),
            );
            step.insert(
                "remove",
                Value::Array(
                    stage
                        .remove
                        .iter()
                        .map(|id| Value::String(id.to_string()))
                        .collect(),
                ),
            );
            step.insert("checkpoint", Value::Bool(true));
            Value::Object(step)
        })
        .collect();
    let mut spec = Map::new();
    spec.insert("index", Value::String(index.to_string()));
    spec.insert("config", reference_config(schema));
    spec.insert("steps", Value::Array(steps));
    let spec_path = scratch.path().join("spec.json");
    std::fs::write(&spec_path, write_json(&Value::Object(spec))).expect("the spec is written");
    let live = scratch.path().join("live");
    let copied = scratch.path().join("copied");
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/reference_segments.mjs");
    let output = Command::new("node")
        .arg(script)
        .arg(repository_root())
        .arg(&spec_path)
        .arg(&live)
        .arg(&copied)
        .output()
        .expect("node runs the TypeScript reference");
    assert!(
        output.status.success(),
        "the TypeScript reference failed; build packages/ts first: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let partition = copied.join("0");
    let mut names: Vec<_> = std::fs::read_dir(&partition)
        .expect("the reference wrote partition 0")
        .map(|entry| entry.expect("the directory lists").path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with('s'))
        })
        .collect();
    names.sort();
    names
        .iter()
        .map(|path| std::fs::read(path).expect("the segment file reads"))
        .collect()
}

fn require_reference_layout(index: &str, schema: &Value, stages: &[Stage<'_>]) {
    let wanted = reference_segment_files(index, schema, stages);
    assert_eq!(
        wanted.len(),
        stages.len(),
        "the reference writes one segment per checkpoint"
    );
    let engine = Narsil::new();
    engine
        .create_index(index, config_of(schema))
        .expect("the index is created");
    for (at, (stage, wanted_file)) in stages.iter().zip(&wanted).enumerate() {
        insert_all(&engine, index, stage.insert);
        remove_all(&engine, index, stage.remove);
        let files = only_partition(&engine, index);
        let file = files
            .get(at)
            .expect("the partition holds this checkpoint's tail");
        require_same_payload(
            &format!("checkpoint {at}"),
            &payload_of(file),
            &payload_of(wanted_file),
        );
        engine
            .freeze_tail_segments(index)
            .expect("the tail freezes");
    }
}

#[test]
fn freezing_tails_with_removals_lays_out_segments_as_the_reference_checkpoint_does() {
    let first = expected_payload("products-p0-s0");
    let second = expected_payload("products-p0-s1");
    let schema = first
        .get("schema")
        .cloned()
        .expect("the payload holds a schema");
    let first_documents = documents_of(&first);
    let second_documents = documents_of(&second);
    let stages = [
        Stage {
            insert: &first_documents,
            remove: &["product-003", "product-010", "product-017", "product-039"],
        },
        Stage {
            insert: &second_documents,
            remove: &["product-001", "product-042"],
        },
    ];
    require_reference_layout(PRODUCTS_INDEX, &schema, &stages);
}

fn layout_documents() -> Vec<Map> {
    let documents = json(
        r#"[
            {"id": "a", "title": "Straße der Einheit", "code": "STRASSE-ẞ-01", "category": "rare", "price": -0.0, "location": {"lat": 51.5, "lon": -0.12}, "tags": ["İstanbul", "ǅemal"], "description": "Weißbier brauereien bavarian"},
            {"id": "b", "title": "Ǆungla ﬃ office", "code": "ﬃ-OFFICE-Σ", "category": "common", "price": 0, "location": {"lat": -33.86, "lon": 151.2}, "tags": ["ΣΊΣΥΦΟΣ"], "description": "Officially efficient offices"},
            {"id": "c", "title": "Deseret 𐐀𐐨 letters", "code": "𐐀𐐁𐐂-x", "category": "common", "price": 12.5, "location": {"lat": 90, "lon": 180}, "tags": [], "description": "Glyphs beyond the basic plane"},
            {"id": "d", "title": "Plain words only", "code": "ABC-def GHI", "category": "middle", "price": -7, "location": {"lat": -90, "lon": -180}, "tags": ["plain"], "description": "Plainly written words"},
            {"id": "e", "title": "Straße noch einmal", "code": "strasse-02", "category": "middle", "price": 12.5, "location": {"lat": 51.5, "lon": -0.12}, "tags": ["Strasse"], "description": "Bavarian brauereien again"}
        ]"#,
    );
    documents
        .as_array()
        .expect("a list of documents")
        .iter()
        .map(|document| document.as_object().cloned().expect("an object"))
        .collect()
}

#[test]
fn freezing_folded_patterns_and_removed_values_lays_out_segments_as_the_reference_does() {
    let schema = json(
        r#"{"title": "string", "code": "string:pattern", "category": "enum", "price": "number", "location": "geopoint", "tags": "string[]", "description": "string:partial"}"#,
    );
    let documents = layout_documents();
    let (first, second) = documents.split_at(3);
    let stages = [
        Stage {
            insert: first,
            remove: &["a"],
        },
        Stage {
            insert: second,
            remove: &["b", "e"],
        },
    ];
    require_reference_layout(LAYOUT_INDEX, &schema, &stages);
}
