mod support;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use narsil::conformance::read_earlier_file;
use narsil::{ErrorCode, Map, Value, parse_json};
use support::{conformance_root, repository_root};

static REFERENCE: OnceLock<Value> = OnceLock::new();

fn reference() -> &'static Value {
    REFERENCE.get_or_init(|| {
        let script =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/reference_earlier.mjs");
        let output = Command::new("node")
            .arg(script)
            .arg(repository_root())
            .output()
            .expect("node runs the reference reader");
        assert!(
            output.status.success(),
            "the reference reader failed; install packages/ts first: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        parse_json(&String::from_utf8(output.stdout).expect("the reference writes UTF-8"))
            .expect("the reference writes JSON")
    })
}

fn samples() -> PathBuf {
    conformance_root().join("samples/earlier-releases/0.3.0")
}

fn entries<'a>(value: &'a Value, key: &str) -> Vec<(&'a String, &'a Value)> {
    value
        .as_object()
        .and_then(|map| map.get(key))
        .and_then(Value::as_object)
        .expect("the reference lists the files")
        .iter()
        .collect()
}

fn read(layout: &str, relative: &str) -> Value {
    let bytes = std::fs::read(samples().join(relative)).expect("the sample is readable");
    read_earlier_file(layout, &bytes)
        .unwrap_or_else(|error| panic!("{relative} fails to read: {error}"))
}

fn sorted(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut out = Map::new();
            for key in keys {
                out.insert(key.clone(), sorted(map.get(key).expect("the key is held")));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
        other => other.clone(),
    }
}

fn recovered_documents(partitions: &Value, vector_parts: Vec<(&String, &Value)>) -> Map {
    let mut documents = Map::new();
    for partition in partitions.as_array().expect("partitions are a list") {
        let listed = partition.pointer("documents").and_then(Value::as_array);
        for pair in listed.expect("a partition lists its documents") {
            let [id, fields] = pair.as_array().expect("a pair").as_slice() else {
                panic!("a document pair holds an ID and its fields");
            };
            let mut fields = fields.as_object().expect("fields are a map").clone();
            fields.remove("id");
            documents.insert(
                id.as_str().expect("an ID").to_string(),
                Value::Object(fields),
            );
        }
    }
    for (path, parts) in vector_parts {
        for part in parts.as_array().expect("parts are a list") {
            let ids = part
                .pointer("docIds")
                .and_then(Value::as_array)
                .expect("docIds");
            let vectors = part
                .pointer("vectors")
                .and_then(Value::as_array)
                .expect("vectors");
            for (id, vector) in ids.iter().zip(vectors) {
                let id = id.as_str().expect("an ID");
                let Some(Value::Object(fields)) = documents.get_mut(id) else {
                    panic!("the vector of {id} has no document");
                };
                fields.insert(path.clone(), vector.clone());
            }
        }
    }
    documents
}

fn exported_by_0_3_0(expected: &str) -> Value {
    let text = std::fs::read_to_string(samples().join("expected").join(expected))
        .expect("the expected documents are readable");
    sorted(&parse_json(&text).expect("the expected documents are JSON"))
}

#[test]
fn snapshot_bundles_hold_the_documents_and_vectors_that_0_3_0_saved() {
    let expected = [
        (
            "snapshot-tier/products/snapshot",
            "snapshot-bundle-products.json",
        ),
        (
            "snapshot-tier-numeric-ids/pantry/snapshot",
            "snapshot-bundle-pantry.json",
        ),
    ];
    for (path, reference_form) in entries(reference(), "bundles") {
        let form = read("snapshot-bundle", path);
        assert_eq!(
            &form, reference_form,
            "{path} differs from the reference reader"
        );
        let fields = form
            .pointer("vectorIndexes")
            .and_then(Value::as_object)
            .expect("fields");
        let parts = fields
            .iter()
            .map(|(field, held)| {
                (
                    field,
                    held.pointer("parts").expect("a field lists its parts"),
                )
            })
            .collect();
        let partitions = form
            .pointer("partitions")
            .expect("the bundle lists partitions");
        let documents = recovered_documents(partitions, parts);
        let (_, file) = expected
            .iter()
            .find(|(listed, _)| listed == path)
            .expect("the bundle has an expected export");
        assert_eq!(
            sorted(&Value::Object(documents)),
            exported_by_0_3_0(file),
            "{path}"
        );
    }
}

#[test]
fn index_snapshot_holds_the_documents_and_vectors_that_0_3_0_returned() {
    for (path, reference_form) in entries(reference(), "snapshots") {
        let form = read("index-snapshot", path);
        assert_eq!(
            &form, reference_form,
            "{path} differs from the reference reader"
        );
        let fields = form
            .pointer("vectorIndexes")
            .and_then(Value::as_object)
            .expect("fields");
        let partitions = form
            .pointer("partitions")
            .expect("the snapshot lists partitions");
        let documents = recovered_documents(partitions, fields.iter().collect());
        let expected = exported_by_0_3_0("index-snapshot-products.json");
        assert_eq!(sorted(&Value::Object(documents)), expected, "{path}");
    }
}

#[test]
fn checkpoint_segments_hold_the_documents_that_the_reference_reads() {
    let segments = entries(reference(), "segments");
    assert!(!segments.is_empty(), "the reference found no segment file");
    for (path, reference_form) in segments {
        assert_eq!(&read("segment-file", path), reference_form, "{path}");
    }
}

fn crafted(name: &str) -> (Vec<u8>, &'static Value) {
    let entry = reference()
        .pointer("crafted")
        .and_then(Value::as_object)
        .and_then(|map| map.get(name))
        .expect("the reference crafted the file");
    let Some(Value::Bytes(bytes)) = entry.pointer("file") else {
        panic!("the crafted file is bytes");
    };
    (
        bytes.clone(),
        entry.pointer("form").expect("the crafted file has a form"),
    )
}

#[test]
fn bundle_with_split_graph_and_stored_vectors_reads_as_the_reference_does() {
    let (bytes, expected) = crafted("graph-in-two-parts");
    let form = read_earlier_file("snapshot-bundle", &bytes).expect("the crafted bundle reads");
    let graphs = form
        .pointer("vectorIndexes.embedding.graphs")
        .and_then(Value::as_array);
    assert_eq!(
        graphs.map(Vec::len),
        Some(2),
        "the first graph and the later nodes"
    );
    assert_eq!(&form, expected);
}

#[test]
fn malformed_bundles_are_refused_with_the_codes_of_the_specification() {
    let cases = [
        (
            "graph-m-below-two",
            ErrorCode::PERSISTENCE_LOAD_FAILED,
            "m must be a whole number from 2 to 512",
        ),
        (
            "graph-upper-lists-beyond-bound",
            ErrorCode::PERSISTENCE_LOAD_FAILED,
            "upper-layer lists",
        ),
        (
            "vectors-short-by-one-component",
            ErrorCode::PERSISTENCE_LOAD_FAILED,
            "dimension float32",
        ),
        (
            "bundle-layout-three",
            ErrorCode::ENVELOPE_VERSION_MISMATCH,
            "layout 3",
        ),
    ];
    for (name, code, phrase) in cases {
        let (bytes, _) = crafted(name);
        let error = read_earlier_file("snapshot-bundle", &bytes)
            .expect_err(&format!("{name} must be refused"));
        assert_eq!(error.code(), code, "{name}: {error}");
        assert!(error.message().contains(phrase), "{name}: {error}");
    }
}
