mod support;

use std::collections::BTreeSet;
use std::path::Path;
use std::process::Command;

use narsil::{
    DurabilityConfig, DurabilityMode, IndexConfig, Map, Narsil, NarsilConfig, QueryResult, Value,
    parse_json, write_json,
};
use support::shaping_json::shaping_params;
use support::{ScratchDirectory, repository_root};

const INDEX: &str = "ledgers";
const SCHEMA: &str = r#"{"title": "string"}"#;
const QUERY: &str =
    r#"{"term": "ledger", "limit": 50, "group": {"fields": ["owner"], "maxPerGroup": 10}}"#;
const REWRITTEN_FIELD: &str = "title";
const REWRITTEN_TITLE: &str = "ledger entry audited twice";
const REWRITTEN: [&str; 5] = ["b1", "c1", "d2", "e2", "h2"];
const DOCUMENTS: &str = r#"[
    {"id": "a1", "title": "ledger entry", "owner": {"name": "registry", "team": "north"}},
    {"id": "b1", "title": "ledger entry", "owner": {"team": "north", "name": "registry"}},
    {"id": "c1", "title": "ledger entry", "owner": {"2": "x", "1": "y"}},
    {"id": "d1", "title": "ledger entry", "owner": {"unit": {"floor": 1, "wing": "east"}}},
    {"id": "e1", "title": "ledger entry", "owner": [{"k": 1, "j": 2}]},
    {"id": "f1", "title": "ledger entry", "owner": [[1, 2], [3]]},
    {"id": "h1", "title": "ledger entry", "owner": {"n": 0}},
    {"id": "a2", "title": "ledger entry", "owner": {"name": "registry", "team": "north"}},
    {"id": "b2", "title": "ledger entry", "owner": {"team": "north", "name": "registry"}},
    {"id": "c2", "title": "ledger entry", "owner": {"1": "y", "2": "x"}},
    {"id": "d2", "title": "ledger entry", "owner": {"unit": {"wing": "east", "floor": 1}}},
    {"id": "e2", "title": "ledger entry", "owner": [{"j": 2, "k": 1}]},
    {"id": "f2", "title": "ledger entry", "owner": [[1, 2], [3]]},
    {"id": "h2", "title": "ledger entry", "owner": {"n": -0}}
]"#;
const GROUPS_BY_OWNER_BYTES: [&[&str]; 10] = [
    &["a1", "a2"],
    &["b1", "b2"],
    &["c1", "c2"],
    &["d1"],
    &["d2"],
    &["e1"],
    &["e2"],
    &["f1", "f2"],
    &["h1"],
    &["h2"],
];

fn object(entries: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    for (key, value) in entries {
        map.insert(key, value);
    }
    Value::Object(map)
}

fn text(value: &str) -> Value {
    Value::String(value.to_string())
}

fn documents() -> Vec<Map> {
    parse_json(DOCUMENTS)
        .expect("the documents are JSON")
        .as_array()
        .expect("the documents are a list")
        .iter()
        .map(|document| document.as_object().expect("a document").clone())
        .collect()
}

fn reference_groups() -> (Value, Value) {
    let scratch = ScratchDirectory::new("group-key-order-reference");
    let documents_path = scratch.path().join("documents.json");
    std::fs::write(&documents_path, DOCUMENTS).expect("the documents are written");
    let spec = object(vec![
        ("index", text(INDEX)),
        (
            "config",
            object(vec![
                ("schema", parse_json(SCHEMA).expect("the schema is JSON")),
                ("language", text("english")),
                ("strict", Value::Bool(false)),
            ]),
        ),
        ("documentsPath", text(&documents_path.to_string_lossy())),
        ("query", parse_json(QUERY).expect("the query is JSON")),
        (
            "rewritten",
            Value::Array(REWRITTEN.iter().map(|id| text(id)).collect()),
        ),
        ("rewrittenField", text(REWRITTEN_FIELD)),
        ("rewrittenValue", text(REWRITTEN_TITLE)),
    ]);
    let spec_path = scratch.path().join("spec.json");
    std::fs::write(&spec_path, write_json(&spec)).expect("the spec is written");
    let script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/reference_group_keys.mjs");
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
    let found = parse_json(&String::from_utf8(output.stdout).expect("the reference writes UTF-8"))
        .expect("the reference writes JSON");
    let part = |name: &str| found.pointer(name).cloned().expect("the reference groups");
    (part("inserts"), part("rewrites"))
}

fn groups_value(result: &QueryResult) -> Value {
    let groups = result.groups.as_ref().expect("the query groups its hits");
    Value::Array(
        groups
            .iter()
            .map(|group| {
                let mut values = Map::new();
                for (field, value) in &group.values {
                    if let Some(value) = value {
                        values.insert(field.clone(), value.clone());
                    }
                }
                object(vec![
                    ("values", Value::Object(values)),
                    (
                        "ids",
                        Value::Array(group.hits.iter().map(|hit| text(&hit.id)).collect()),
                    ),
                ])
            })
            .collect(),
    )
}

fn crate_groups(narsil: &Narsil) -> Value {
    let query = parse_json(QUERY).expect("the query is JSON");
    let result = narsil
        .query(INDEX, &shaping_params(&query))
        .expect("the grouped query answers");
    groups_value(&result)
}

fn id_sets(groups: &Value) -> BTreeSet<Vec<String>> {
    groups
        .as_array()
        .expect("a list of groups")
        .iter()
        .map(|group| {
            let mut ids: Vec<String> = group
                .pointer("ids")
                .and_then(Value::as_array)
                .expect("a group lists its hits")
                .iter()
                .map(|id| id.as_str().expect("an ID").to_string())
                .collect();
            ids.sort();
            ids
        })
        .collect()
}

fn groups_by_owner_bytes() -> BTreeSet<Vec<String>> {
    GROUPS_BY_OWNER_BYTES
        .iter()
        .map(|ids| ids.iter().map(|id| id.to_string()).collect())
        .collect()
}

fn as_json_text_writes_it(value: &Value) -> Value {
    match value {
        Value::Number(number) if *number == 0.0 => Value::Number(0.0),
        Value::Array(elements) => {
            Value::Array(elements.iter().map(as_json_text_writes_it).collect())
        }
        Value::Object(map) => {
            let mut written = Map::new();
            for (key, member) in map.iter() {
                written.insert(key.clone(), as_json_text_writes_it(member));
            }
            Value::Object(written)
        }
        other => other.clone(),
    }
}

fn require_groups(found: &Value, wanted: &Value, when: &str) {
    assert_eq!(
        id_sets(wanted),
        groups_by_owner_bytes(),
        "the reference groups by the bytes of each object {when}"
    );
    assert_eq!(
        write_json(&as_json_text_writes_it(found)),
        write_json(wanted),
        "the crate groups as the reference does {when}"
    );
}

fn config(root: &Path) -> NarsilConfig {
    NarsilConfig {
        durability: Some(DurabilityConfig {
            directory: Some(root.to_path_buf()),
            mode: Some(DurabilityMode::Sync),
            ..DurabilityConfig::default()
        }),
        ..NarsilConfig::default()
    }
}

#[test]
fn the_key_order_of_an_undeclared_object_decides_its_group_through_rewrites_and_a_restart() {
    let (inserts, rewrites) = reference_groups();
    let root = ScratchDirectory::new("group-key-order");
    let narsil = Narsil::open(config(root.path())).expect("the engine opens");
    narsil
        .create_index(
            INDEX,
            IndexConfig {
                schema: parse_json(SCHEMA).expect("the schema is JSON"),
                language: Some("english".to_string()),
                strict: Some(false),
                ..IndexConfig::default()
            },
        )
        .expect("the index is created");
    let inserted = narsil
        .insert_batch(INDEX, documents())
        .expect("the documents are inserted");
    assert!(
        inserted.failed.is_empty(),
        "the crate refused {:?}",
        inserted.failed
    );
    require_groups(&crate_groups(&narsil), &inserts, "after the inserts");

    for id in REWRITTEN {
        let mut held = narsil
            .get(INDEX, id)
            .expect("the document reads")
            .expect("the index holds the document");
        held.insert(REWRITTEN_FIELD, text(REWRITTEN_TITLE));
        narsil
            .update(INDEX, id, held)
            .expect("the document is updated");
    }
    require_groups(&crate_groups(&narsil), &rewrites, "after the rewrites");

    narsil.shutdown().expect("the engine shuts down");
    let narsil = Narsil::open(config(root.path())).expect("the engine reopens");
    require_groups(&crate_groups(&narsil), &rewrites, "after a restart");
    narsil.shutdown().expect("the engine shuts down at the end");
}
