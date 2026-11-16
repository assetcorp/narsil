mod support;

use std::collections::BTreeMap;
use std::path::Path;

use narsil::{Map, Value};
use narsil_server::ServerOptions;
use support::{Call, ReferenceServer, RustServer, ScratchDirectory, object, same_status_and_code};

const SEEDED_DOCUMENTS: usize = 40;

struct Pair {
    rust: RustServer,
    reference: ReferenceServer,
}

async fn start(directory: &Path) -> Pair {
    let rust_directory = directory.join("rust");
    let reference_directory = directory.join("typescript");
    std::fs::create_dir_all(&rust_directory).expect("the Rust directory is created");
    std::fs::create_dir_all(&reference_directory).expect("the TypeScript directory is created");
    let rust = RustServer::durable(&rust_directory, ServerOptions::default()).await;
    let reference = ReferenceServer::start(object(vec![(
        "directory",
        Value::String(reference_directory.to_string_lossy().into_owned()),
    )]))
    .await;
    Pair { rust, reference }
}

impl Pair {
    async fn send(&self, call: &Call<'_>) -> Value {
        let (mine, theirs) = same_status_and_code(self.rust.port, self.reference.port, call).await;
        assert!(
            mine.status < 300,
            "{} {} succeeds: {}",
            call.method,
            call.path,
            String::from_utf8_lossy(&mine.body)
        );
        assert_eq!(
            mine.json(),
            theirs.json(),
            "{} {} answers as TypeScript does",
            call.method,
            call.path
        );
        mine.json()
    }

    async fn stop(self) {
        self.reference.stop().await;
        self.rust.stop().await;
    }
}

fn entry(id: &str, title: &str, n: f64) -> Value {
    object(vec![
        ("id", Value::String(id.to_string())),
        ("title", Value::String(title.to_string())),
        ("n", Value::Number(n)),
    ])
}

async fn same_as_model(pair: &Pair, model: &BTreeMap<String, Value>, probe: &[String]) {
    let count = pair.send(&Call::new("GET", "/indexes/ledger/count")).await;
    assert_eq!(
        count,
        object(vec![("count", Value::Number(model.len() as f64))])
    );
    let request = object(vec![(
        "docIds",
        Value::Array(probe.iter().cloned().map(Value::String).collect()),
    )]);
    let fetched = pair
        .send(&Call::new("POST", "/indexes/ledger/documents/_multi-get").json(&request))
        .await;
    let mut expected = Map::new();
    for id in probe {
        if let Some(document) = model.get(id) {
            expected.insert(id.clone(), document.clone());
        }
    }
    assert_eq!(
        fetched,
        object(vec![("documents", Value::Object(expected))])
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn writes_survive_restarts_and_a_close_and_reopen_of_the_index() {
    let scratch = ScratchDirectory::new("documents-durable");
    let mut model: BTreeMap<String, Value> = BTreeMap::new();
    let mut probe: Vec<String> = (0..SEEDED_DOCUMENTS + 2)
        .map(|n| format!("doc-{n}"))
        .collect();
    probe.push("doc-new".to_string());

    let pair = start(scratch.path()).await;
    let config = object(vec![(
        "schema",
        object(vec![
            ("title", Value::String("string".to_string())),
            ("n", Value::String("number".to_string())),
        ]),
    )]);
    pair.send(&Call::new("POST", "/indexes").json(&object(vec![
        ("name", Value::String("ledger".to_string())),
        ("config", config),
    ])))
    .await;
    let seeded: Vec<Value> = (0..SEEDED_DOCUMENTS)
        .map(|n| entry(&format!("doc-{n}"), &format!("entry {n}"), n as f64))
        .collect();
    for document in &seeded {
        if let Value::Object(fields) = document
            && let Some(Value::String(id)) = fields.get("id")
        {
            model.insert(id.clone(), document.clone());
        }
    }
    pair.send(
        &Call::new("POST", "/indexes/ledger/documents/_batch")
            .json(&object(vec![("documents", Value::Array(seeded))])),
    )
    .await;
    let replaced = entry("doc-1", "entry one replaced", 101.0);
    pair.send(
        &Call::new("PUT", "/indexes/ledger/documents/doc-1")
            .json(&object(vec![("document", replaced.clone())])),
    )
    .await;
    model.insert("doc-1".to_string(), replaced);
    let created = entry("doc-new", "created by put", 7.0);
    pair.send(
        &Call::new("PUT", "/indexes/ledger/documents/doc-new")
            .json(&object(vec![("document", created.clone())])),
    )
    .await;
    model.insert("doc-new".to_string(), created);
    pair.send(&Call::new("DELETE", "/indexes/ledger/documents/doc-3"))
        .await;
    model.remove("doc-3");
    pair.send(
        &Call::new("POST", "/indexes/ledger/documents/_batch").json(&object(vec![
            ("action", Value::String("delete".to_string())),
            (
                "docIds",
                Value::Array(vec![
                    Value::String("doc-4".to_string()),
                    Value::String("doc-5".to_string()),
                ]),
            ),
        ])),
    )
    .await;
    model.remove("doc-4");
    model.remove("doc-5");
    pair.send(&Call::new("POST", "/indexes/ledger/_wait-for-writes"))
        .await;
    same_as_model(&pair, &model, &probe).await;
    pair.stop().await;

    let pair = start(scratch.path()).await;
    same_as_model(&pair, &model, &probe).await;
    let patched = entry("doc-2", "entry two patched", 202.0);
    pair.send(
        &Call::new("PATCH", "/indexes/ledger/documents/doc-2")
            .json(&object(vec![("document", patched.clone())])),
    )
    .await;
    model.insert("doc-2".to_string(), patched);
    pair.send(&Call::new("POST", "/indexes/ledger/_close"))
        .await;
    pair.send(&Call::new("POST", "/indexes/ledger/_open")).await;
    same_as_model(&pair, &model, &probe).await;
    pair.send(&Call::new("POST", "/indexes/ledger/_close"))
        .await;
    pair.stop().await;

    let pair = start(scratch.path()).await;
    pair.send(&Call::new("POST", "/indexes/ledger/_open")).await;
    same_as_model(&pair, &model, &probe).await;
    pair.send(&Call::new("POST", "/indexes/ledger/_clear"))
        .await;
    model.clear();
    pair.stop().await;

    let pair = start(scratch.path()).await;
    same_as_model(&pair, &model, &probe).await;
    pair.send(&Call::new("DELETE", "/indexes/ledger")).await;
    pair.stop().await;

    let pair = start(scratch.path()).await;
    let listed = pair.send(&Call::new("GET", "/indexes")).await;
    assert_eq!(listed, object(vec![("indexes", Value::Array(Vec::new()))]));
    pair.stop().await;
}
