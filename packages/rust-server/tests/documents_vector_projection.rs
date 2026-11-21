mod support;

use std::collections::BTreeMap;

use narsil::{Map, Value};
use narsil_server::ServerOptions;
use support::{Call, RustServer, ScratchDirectory, object, parsed, send};

const SCHEMA: &str =
    r#"{"title":"string","meta":{"tag":"string","embedding":"vector[3]"},"embedding":"vector[3]"}"#;
const NOTES: [(&str, &str); 3] = [
    (
        "a",
        r#"{"title":"harbor stone","meta":{"tag":"x","embedding":[0.5,-0.25,1]},"embedding":[0.125,0.25,-0.5]}"#,
    ),
    (
        "b",
        r#"{"title":"harbor river","meta":{"tag":"y"},"embedding":[-1,0.75,0.5]}"#,
    ),
    ("c", r#"{"title":"harbor light","meta":{"tag":"x"}}"#),
];
const HOSTILE_FLAGS: &str = r#"[null,0,1,"true","false",[],[true],{}]"#;
const HOSTILE_QUERY_FLAGS: [&str; 7] = ["", "TRUE", "False", "1", "0", "yes", "true%00"];

fn note(id: &str) -> Value {
    let found = NOTES.iter().find(|(note, _)| *note == id);
    let (_, fields) = found.unwrap_or_else(|| panic!("note {id} exists"));
    parsed(fields)
}

fn without_vectors(document: &Value) -> Value {
    let mut document = document.clone();
    if let Value::Object(map) = &mut document {
        map.remove("embedding");
        if let Some(Value::Object(meta)) = map.get_mut("meta") {
            meta.remove("embedding");
        }
    }
    document
}

async fn created(port: u16, name: &str, extra: Vec<(&str, Value)>) -> u16 {
    let mut config = vec![("schema", parsed(SCHEMA))];
    config.extend(extra);
    let reply = send(
        port,
        &Call::new("POST", "/indexes").json(&object(vec![
            ("name", Value::from(name)),
            ("config", object(config)),
        ])),
    )
    .await;
    reply.status
}

async fn stored(port: u16, index: &str) {
    for (id, _) in NOTES {
        let target = format!("/indexes/{index}/documents/{id}");
        let fields = note(id);
        let reply = send(
            port,
            &Call::new("PUT", &target).json(&object(vec![("document", fields)])),
        )
        .await;
        assert_eq!(reply.status, 201, "the server stores note {id}");
    }
}

async fn read_one(port: u16, index: &str, id: &str, query: &str) -> (u16, Value) {
    let target = format!("/indexes/{index}/documents/{id}{query}");
    let reply = send(port, &Call::new("GET", &target)).await;
    (reply.status, reply.json())
}

async fn posted(port: u16, index: &str, route: &str, body: Value) -> (u16, Value) {
    let target = format!("/indexes/{index}/{route}");
    let reply = send(port, &Call::new("POST", &target).json(&body)).await;
    (reply.status, reply.json())
}

fn by_id(answer: &Value, list: &str, member: &str) -> BTreeMap<String, Value> {
    let Some(Value::Array(items)) = answer.as_object().and_then(|body| body.get(list)) else {
        panic!("the answer lists {list}: {answer:?}");
    };
    items
        .iter()
        .map(|item| {
            let item = item.as_object().expect("each entry is an object");
            let id = item.get("id").and_then(Value::as_str).expect("an ID");
            (
                id.to_string(),
                item.get(member).cloned().unwrap_or(Value::Null),
            )
        })
        .collect()
}

fn error_code(answer: &Value) -> Option<&str> {
    answer
        .as_object()?
        .get("error")?
        .as_object()?
        .get("code")?
        .as_str()
}

async fn require_reads(
    port: u16,
    index: &str,
    document: Option<Value>,
    oracle: fn(&Value) -> Value,
) {
    let label = format!("{index} with {document:?}");
    let query = match &document {
        None => String::new(),
        Some(Value::Object(map)) => match map.get("vectors") {
            Some(Value::Bool(vectors)) if map.len() == 1 => format!("?vectors={vectors}"),
            _ => return require_bodies(port, index, document, oracle, &label).await,
        },
        Some(_) => return require_bodies(port, index, document, oracle, &label).await,
    };
    for (id, _) in NOTES {
        let (status, answer) = read_one(port, index, id, &query).await;
        assert_eq!(status, 200, "{label}: GET {id}");
        let found = answer.as_object().and_then(|body| body.get("document"));
        assert_eq!(found, Some(&oracle(&note(id))), "{label}: GET {id}");
    }
    require_bodies(port, index, document, oracle, &label).await;
}

async fn require_bodies(
    port: u16,
    index: &str,
    document: Option<Value>,
    oracle: fn(&Value) -> Value,
    label: &str,
) {
    let with_document = |mut body: Vec<(&'static str, Value)>| {
        if let Some(document) = &document {
            body.push(("document", document.clone()));
        }
        object(body)
    };
    let ids = Value::Array(NOTES.iter().map(|(id, _)| Value::from(*id)).collect());
    let (status, answer) = posted(
        port,
        index,
        "documents/_multi-get",
        with_document(vec![("docIds", ids)]),
    )
    .await;
    assert_eq!(status, 200, "{label}: multi-get {answer:?}");
    let documents = answer
        .as_object()
        .and_then(|body| body.get("documents"))
        .and_then(Value::as_object)
        .expect("the multi-get answer maps IDs to documents");
    assert_eq!(documents.len(), NOTES.len(), "{label}: multi-get");
    for (id, found) in documents.iter() {
        assert_eq!(found, &oracle(&note(id)), "{label}: multi-get {id}");
    }
    let searched = with_document(vec![("term", Value::from("harbor"))]);
    let listed = with_document(vec![]);
    for (route, body, list) in [
        ("search", searched, "hits"),
        ("documents/_list", listed, "documents"),
    ] {
        let (status, answer) = posted(port, index, route, body).await;
        assert_eq!(status, 200, "{label}: {route} {answer:?}");
        let found = by_id(&answer, list, "document");
        assert_eq!(found.len(), NOTES.len(), "{label}: {route}");
        for (id, document) in found {
            assert_eq!(document, oracle(&note(&id)), "{label}: {route} {id}");
        }
    }
}

fn whole(document: &Value) -> Value {
    document.clone()
}

fn titles_and_vectors(document: &Value) -> Value {
    let map = document.as_object().expect("a note is an object");
    let mut kept = Map::new();
    for key in ["title", "embedding"] {
        if let Some(value) = map.get(key) {
            kept.insert(key, value.clone());
        }
    }
    Value::Object(kept)
}

#[tokio::test(flavor = "multi_thread")]
async fn every_read_route_leaves_vectors_out_unless_the_caller_or_the_index_asks() {
    let server = RustServer::in_memory(ServerOptions::default()).await;
    assert_eq!(created(server.port, "plain", vec![]).await, 201);
    let flag = vec![("returnVectors", Value::Bool(true))];
    assert_eq!(created(server.port, "vectors", flag).await, 201);
    for index in ["plain", "vectors"] {
        stored(server.port, index).await;
    }
    let vectors = |flag: bool| Some(object(vec![("vectors", Value::Bool(flag))]));
    require_reads(server.port, "plain", None, without_vectors).await;
    require_reads(server.port, "plain", vectors(true), whole).await;
    require_reads(server.port, "plain", vectors(false), without_vectors).await;
    require_reads(server.port, "vectors", None, whole).await;
    require_reads(server.port, "vectors", vectors(false), without_vectors).await;
    let included = Some(parsed(r#"{"include":["title","embedding"]}"#));
    require_reads(server.port, "plain", included, titles_and_vectors).await;
    let excluded = Some(parsed(
        r#"{"include":["title","embedding"],"vectors":false}"#,
    ));
    require_reads(server.port, "vectors", excluded, |document| {
        without_vectors(&titles_and_vectors(document))
    })
    .await;
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn malformed_vector_options_are_refused_on_every_route() {
    let server = RustServer::in_memory(ServerOptions::default()).await;
    let port = server.port;
    assert_eq!(created(port, "notes", vec![]).await, 201);
    stored(port, "notes").await;
    for hostile in parsed(HOSTILE_FLAGS).as_array().expect("a list").clone() {
        let reply = send(
            port,
            &Call::new("POST", "/indexes").json(&object(vec![
                ("name", Value::from("refused")),
                (
                    "config",
                    object(vec![
                        ("schema", parsed(SCHEMA)),
                        ("returnVectors", hostile.clone()),
                    ]),
                ),
            ])),
        )
        .await;
        assert_eq!(
            (reply.status, reply.error_code().as_deref()),
            (400, Some("CONFIG_INVALID")),
            "returnVectors {hostile:?}"
        );
        let projection = object(vec![("vectors", hostile.clone())]);
        let ids = Value::Array(vec![Value::from("a")]);
        let bodies = [
            (
                "documents/_multi-get",
                object(vec![("docIds", ids), ("document", projection.clone())]),
            ),
            (
                "documents/_list",
                object(vec![("document", projection.clone())]),
            ),
        ];
        for (route, body) in bodies {
            let (status, answer) = posted(port, "notes", route, body).await;
            assert_eq!(
                (status, error_code(&answer)),
                (400, Some("SEARCH_INVALID_FIELD")),
                "{route} with vectors {hostile:?}: {answer:?}"
            );
        }
        let search = object(vec![
            ("term", Value::from("harbor")),
            ("document", projection),
        ]);
        let (status, answer) = posted(port, "notes", "search", search).await;
        let expected = if hostile.is_null() {
            (200, None)
        } else {
            (400, Some("SEARCH_INVALID_FIELD"))
        };
        assert_eq!(
            (status, error_code(&answer)),
            expected,
            "search with vectors {hostile:?}: {answer:?}"
        );
        if status == 200 {
            for (id, document) in by_id(&answer, "hits", "document") {
                assert_eq!(
                    document,
                    without_vectors(&note(&id)),
                    "search with vectors null"
                );
            }
        }
    }
    for hostile in ["5", "\"all\"", "[]"] {
        let body = format!(r#"{{"docIds":["a"],"document":{hostile}}}"#);
        let (status, answer) = posted(port, "notes", "documents/_multi-get", parsed(&body)).await;
        assert_eq!(
            (status, error_code(&answer)),
            (400, Some("SEARCH_INVALID_FIELD")),
            "multi-get with document {hostile}"
        );
    }
    for document in [
        "5",
        "\"all\"",
        "[]",
        r#"{"include":5}"#,
        r#"{"include":[1]}"#,
        r#"{"exclude":"title"}"#,
        r#"{"exclude":[true]}"#,
        r#"{"vectors":"true"}"#,
    ] {
        for route in ["search", "search/preflight"] {
            let body = format!(r#"{{"term":"harbor","document":{document}}}"#);
            let (status, answer) = posted(port, "notes", route, parsed(&body)).await;
            assert_eq!(
                (status, error_code(&answer)),
                (400, Some("SEARCH_INVALID_FIELD")),
                "{route} with document {document}: {answer:?}"
            );
        }
    }
    for hostile in HOSTILE_QUERY_FLAGS {
        let (status, answer) = read_one(port, "notes", "a", &format!("?vectors={hostile}")).await;
        assert_eq!(
            (status, error_code(&answer)),
            (400, Some("SEARCH_INVALID_FIELD")),
            "GET with vectors={hostile}"
        );
    }
    let (status, answer) = read_one(port, "notes", "absent", "?vectors=true").await;
    assert_eq!((status, error_code(&answer)), (404, Some("DOC_NOT_FOUND")));
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_return_vectors_setting_survives_a_restart_of_the_server() {
    let scratch = ScratchDirectory::new("vector-projection-restart");
    let directory = scratch.path().join("data");
    std::fs::create_dir_all(&directory).expect("the data directory is created");
    let server = RustServer::durable(&directory, ServerOptions::default()).await;
    let flag = vec![("returnVectors", Value::Bool(true))];
    assert_eq!(created(server.port, "vectors", flag).await, 201);
    assert_eq!(created(server.port, "plain", vec![]).await, 201);
    for index in ["vectors", "plain"] {
        stored(server.port, index).await;
    }
    server.stop().await;
    let reopened = RustServer::durable(&directory, ServerOptions::default()).await;
    require_reads(reopened.port, "vectors", None, whole).await;
    require_reads(reopened.port, "plain", None, without_vectors).await;
    reopened.stop().await;
}
