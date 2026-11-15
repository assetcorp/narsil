mod documents_replay;
mod support;

use documents_replay::{comparable, without_engine_error_details};
use narsil::{Map, Value};
use narsil_server::{ServerLimits, ServerOptions};
use support::{Call, ReferenceServer, Reply, RustServer, object, same_status_and_code};

const STORED_DOCUMENTS: usize = 300;
const FETCHED_DOCUMENTS: usize = 250;
const BODY_LIMIT_BYTES: usize = 8192;

fn document(position: usize) -> Value {
    object(vec![
        ("id", Value::String(format!("doc-{position}"))),
        (
            "title",
            Value::String(format!("title number {position} ü \"quoted\"")),
        ),
        ("n", Value::Number(position as f64)),
    ])
}

fn shuffled_ids() -> Vec<String> {
    let mut ids: Vec<String> = (0..FETCHED_DOCUMENTS)
        .map(|step| format!("doc-{}", (step * 7919) % STORED_DOCUMENTS))
        .collect();
    ids.insert(3, "doc-missing".to_string());
    ids.push(ids[10].clone());
    ids
}

async fn both(rust: &RustServer, reference: &ReferenceServer, call: &Call<'_>) -> (Reply, Reply) {
    same_status_and_code(rust.port, reference.port, call).await
}

async fn same_answer(rust: &RustServer, reference: &ReferenceServer, call: &Call<'_>) -> Value {
    let (mine, theirs) = both(rust, reference, call).await;
    let mine = mine.json();
    assert_eq!(
        comparable(&mine),
        comparable(&without_engine_error_details(&theirs.json(), &mine)),
        "{} {} answers with the TypeScript body",
        call.method,
        call.path
    );
    mine
}

async fn servers(limits: ServerLimits, reference_limits: Value) -> (RustServer, ReferenceServer) {
    let rust = RustServer::in_memory(ServerOptions {
        limits,
        ..ServerOptions::default()
    })
    .await;
    let reference = ReferenceServer::start(object(vec![("limits", reference_limits)])).await;
    (rust, reference)
}

fn index_body(name: &str) -> Value {
    object(vec![
        ("name", Value::String(name.to_string())),
        (
            "config",
            object(vec![(
                "schema",
                object(vec![
                    ("title", Value::String("string".to_string())),
                    ("n", Value::String("number".to_string())),
                ]),
            )]),
        ),
    ])
}

#[tokio::test(flavor = "multi_thread")]
async fn a_large_multi_get_streams_the_stored_documents_in_request_order() {
    let (rust, reference) = servers(ServerLimits::default(), object(vec![])).await;
    same_answer(
        &rust,
        &reference,
        &Call::new("POST", "/indexes").json(&index_body("shelf")),
    )
    .await;
    let stored: Vec<Value> = (0..STORED_DOCUMENTS).map(document).collect();
    let batch = object(vec![("documents", Value::Array(stored.clone()))]);
    let written = same_answer(
        &rust,
        &reference,
        &Call::new("POST", "/indexes/shelf/documents/_batch").json(&batch),
    )
    .await;
    let expected_ids: Vec<Value> = (0..STORED_DOCUMENTS)
        .map(|position| Value::String(format!("doc-{position}")))
        .collect();
    assert_eq!(
        written,
        object(vec![
            ("succeeded", Value::Array(expected_ids)),
            ("failed", Value::Array(Vec::new())),
        ])
    );

    let wanted = shuffled_ids();
    let request = object(vec![(
        "docIds",
        Value::Array(wanted.iter().cloned().map(Value::String).collect()),
    )]);
    let call = Call::new("POST", "/indexes/shelf/documents/_multi-get").json(&request);
    let (mine, theirs) = both(&rust, &reference, &call).await;
    assert_eq!(
        mine.body, theirs.body,
        "the streamed answer matches the TypeScript bytes"
    );

    let mut oracle = Map::new();
    for id in &wanted {
        let Some(position) = id
            .strip_prefix("doc-")
            .and_then(|n| n.parse::<usize>().ok())
        else {
            continue;
        };
        if !oracle.contains_key(id) {
            oracle.insert(id.clone(), stored[position].clone());
        }
    }
    assert_eq!(
        mine.json(),
        object(vec![("documents", Value::Object(oracle))]),
        "the answer holds each stored document once, in the order that the request asks for them"
    );

    let count = same_answer(&rust, &reference, &Call::new("GET", "/indexes/shelf/count")).await;
    assert_eq!(
        count,
        object(vec![("count", Value::Number(STORED_DOCUMENTS as f64))])
    );
    reference.stop().await;
    rust.stop().await;
}

fn padded_insert(total_bytes: usize) -> String {
    let frame = "{\"document\":{\"title\":\"\"}}";
    let padding = total_bytes.saturating_sub(frame.len());
    format!("{{\"document\":{{\"title\":\"{}\"}}}}", "x".repeat(padding))
}

#[tokio::test(flavor = "multi_thread")]
async fn the_body_limit_refuses_one_byte_past_the_typescript_boundary() {
    let (rust, reference) = servers(
        ServerLimits {
            max_body_bytes: Some(BODY_LIMIT_BYTES as u64),
            ..ServerLimits::default()
        },
        object(vec![(
            "maxBodyBytes",
            Value::Number(BODY_LIMIT_BYTES as f64),
        )]),
    )
    .await;
    same_answer(
        &rust,
        &reference,
        &Call::new("POST", "/indexes").json(&index_body("shelf")),
    )
    .await;

    for total in [BODY_LIMIT_BYTES - 1, BODY_LIMIT_BYTES, BODY_LIMIT_BYTES + 1] {
        let body = padded_insert(total);
        assert_eq!(body.len(), total);
        let call = Call::new("POST", "/indexes/shelf/documents")
            .header("content-type", "application/json")
            .raw(body);
        let (mine, _) = both(&rust, &reference, &call).await;
        let expected = if total > BODY_LIMIT_BYTES { 413 } else { 201 };
        assert_eq!(
            mine.status, expected,
            "a {total}-byte body answers {expected}"
        );
    }
    let count = same_answer(&rust, &reference, &Call::new("GET", "/indexes/shelf/count")).await;
    assert_eq!(count, object(vec![("count", Value::Number(2.0))]));
    reference.stop().await;
    rust.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_fetch_limit_counts_every_requested_id() {
    let fetch_limit: u64 = 10_000;
    let (rust, reference) = servers(ServerLimits::default(), object(vec![])).await;
    same_answer(
        &rust,
        &reference,
        &Call::new("POST", "/indexes").json(&index_body("shelf")),
    )
    .await;
    for count in [fetch_limit, fetch_limit + 1] {
        let ids: Vec<Value> = (0..count)
            .map(|_| Value::String("same".to_string()))
            .collect();
        let request = object(vec![("docIds", Value::Array(ids))]);
        let call = Call::new("POST", "/indexes/shelf/documents/_multi-get").json(&request);
        let answer = same_answer(&rust, &reference, &call).await;
        if count > fetch_limit {
            let Value::Object(body) = answer else {
                panic!("the refusal is an object");
            };
            assert!(body.contains_key("error"), "{count} ids exceed the limit");
        } else {
            assert_eq!(
                answer,
                object(vec![("documents", Value::Object(Map::new()))])
            );
        }
    }
    reference.stop().await;
    rust.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_index_list_and_memory_report_describe_the_same_indexes() {
    let (rust, reference) = servers(ServerLimits::default(), object(vec![])).await;
    for name in ["shelf", "archive", "drafts"] {
        same_answer(
            &rust,
            &reference,
            &Call::new("POST", "/indexes").json(&index_body(name)),
        )
        .await;
    }
    let batch = object(vec![(
        "documents",
        Value::Array((0..5).map(document).collect()),
    )]);
    same_answer(
        &rust,
        &reference,
        &Call::new("POST", "/indexes/archive/documents/_batch").json(&batch),
    )
    .await;
    same_answer(
        &rust,
        &reference,
        &Call::new("POST", "/indexes/drafts/_close"),
    )
    .await;

    let listed = |reply: &Reply| -> Vec<Value> {
        let Value::Object(body) = reply.json() else {
            panic!("the list is an object");
        };
        let Some(Value::Array(indexes)) = body.get("indexes").cloned() else {
            panic!("the list holds an indexes array");
        };
        sorted_by(indexes, "name")
    };
    let (mine, theirs) = both(&rust, &reference, &Call::new("GET", "/indexes")).await;
    assert_eq!(
        listed(&mine),
        listed(&theirs),
        "both servers list the same indexes"
    );
    let counts: Vec<(String, Value)> = listed(&mine)
        .iter()
        .filter_map(|entry| match entry {
            Value::Object(entry) => match (entry.get("name"), entry.get("documentCount")) {
                (Some(Value::String(name)), Some(count)) => Some((name.clone(), count.clone())),
                _ => None,
            },
            _ => None,
        })
        .collect();
    assert_eq!(
        counts,
        vec![
            ("archive".to_string(), Value::Number(5.0)),
            ("drafts".to_string(), Value::Number(0.0)),
            ("shelf".to_string(), Value::Number(0.0)),
        ]
    );

    let (mine, theirs) = both(&rust, &reference, &Call::new("GET", "/stats/memory")).await;
    let report = |reply: &Reply| -> Map {
        let Value::Object(mut body) = reply.json() else {
            panic!("the memory report is an object");
        };
        for measured in ["process", "estimatedIndexBytes"] {
            let shape = body.get(measured).map(comparable_kind);
            body.insert(measured, shape.unwrap_or(Value::Null));
        }
        if let Some(Value::Array(copies)) = body.get("workerCopies").cloned() {
            body.insert("workerCopies", Value::Array(sorted_by(copies, "indexName")));
        }
        body
    };
    assert_eq!(
        report(&mine),
        report(&theirs),
        "both servers report the same memory fields"
    );
    reference.stop().await;
    rust.stop().await;
}

fn sorted_by(mut entries: Vec<Value>, key: &str) -> Vec<Value> {
    entries.sort_by_key(|entry| match entry {
        Value::Object(entry) => match entry.get(key) {
            Some(Value::String(name)) => name.clone(),
            _ => String::new(),
        },
        _ => String::new(),
    });
    entries
}

fn comparable_kind(value: &Value) -> Value {
    match value {
        Value::Object(entries) => {
            let mut keys: Vec<String> = entries.iter().map(|(key, _)| key.clone()).collect();
            keys.sort();
            Value::Array(keys.into_iter().map(Value::String).collect())
        }
        Value::Number(_) => Value::String("number".to_string()),
        other => other.clone(),
    }
}
