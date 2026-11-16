#![allow(dead_code)]

use std::path::Path;
use std::time::Duration;

use narsil::{IndexConfig, Map, Narsil, NarsilConfig, Value};
use narsil_server::{FeedOptions, ServerOptions};

use crate::support::{
    Call, ReferenceServer, Reply, RustServer, TOKEN, decode_json, object, send, token_hook,
};

pub const INDEX: &str = "notes";
pub const SCHEMA: &str =
    r#"{"title":"string","tags":"string[]","price":"number","embedding":"vector[3]"}"#;
const TASK_DEADLINE: Duration = Duration::from_secs(60);
const TASK_POLL: Duration = Duration::from_millis(50);

pub fn note(at: usize) -> Map {
    let mut note = Map::new();
    note.insert("title", Value::String(format!("field note {at}")));
    note.insert(
        "tags",
        Value::Array(vec![
            Value::String("travel".to_string()),
            Value::String(format!("trip {}", at % 5)),
        ]),
    );
    note.insert("price", Value::Number(at as f64 * 1.5));
    note.insert(
        "embedding",
        Value::Array(vec![
            Value::Number(1.0),
            Value::Number(at as f64),
            Value::Number(0.5),
        ]),
    );
    note
}

pub fn note_id(at: usize) -> String {
    format!("note-{at}")
}

pub fn index_config() -> IndexConfig {
    IndexConfig {
        schema: decode_json(SCHEMA).expect("the schema is JSON"),
        ..IndexConfig::default()
    }
}

pub fn durable_engine(directory: &Path) -> Narsil {
    Narsil::open(NarsilConfig {
        durability: Some(narsil::DurabilityConfig {
            directory: Some(directory.to_path_buf()),
            ..narsil::DurabilityConfig::default()
        }),
        ..NarsilConfig::default()
    })
    .expect("the durable engine opens")
}

pub fn seed(engine: &Narsil, count: usize) {
    engine
        .create_index(INDEX, index_config())
        .expect("the index is created");
    insert_notes(engine, 0..count);
}

pub fn insert_notes(engine: &Narsil, range: std::ops::Range<usize>) {
    for at in range {
        engine
            .insert(INDEX, note(at), Some(&note_id(at)))
            .expect("the note is inserted");
    }
}

pub fn feed_options(sync: bool, changes: bool) -> ServerOptions {
    token_hook(ServerOptions {
        sync: sync.then(FeedOptions::default),
        changes: changes.then(FeedOptions::default),
        ..ServerOptions::default()
    })
}

pub fn reference_spec(directory: Option<&Path>, sync: bool, changes: bool) -> Value {
    let mut entries = vec![("token", Value::String(TOKEN.to_string()))];
    if let Some(directory) = directory {
        entries.push((
            "directory",
            Value::String(directory.to_string_lossy().into_owned()),
        ));
    }
    if sync {
        entries.push(("sync", Value::Object(Map::new())));
    }
    if changes {
        entries.push(("changes", Value::Object(Map::new())));
    }
    object(entries)
}

pub async fn seed_reference(reference: &ReferenceServer, count: usize) {
    let schema = decode_json(SCHEMA).expect("the schema is JSON");
    let created = send(
        reference.port,
        &Call::new("POST", "/indexes")
            .authorized()
            .json(&object(vec![
                ("name", Value::String(INDEX.to_string())),
                ("config", object(vec![("schema", schema)])),
            ])),
    )
    .await;
    assert_eq!(created.status, 201, "{:?}", created.body);
    if count == 0 {
        return;
    }
    let documents = (0..count)
        .map(|at| {
            let mut document = note(at);
            document.insert("id", Value::String(note_id(at)));
            Value::Object(document)
        })
        .collect();
    let inserted = send(
        reference.port,
        &Call::new("POST", &format!("/indexes/{INDEX}/documents/_batch"))
            .authorized()
            .json(&object(vec![("documents", Value::Array(documents))])),
    )
    .await;
    assert_eq!(inserted.status, 200, "{:?}", inserted.body);
}

pub fn envelope_of(reply: &Reply) -> (u16, Value) {
    let error = match reply.json() {
        Value::Object(mut body) => body.remove("error").unwrap_or(Value::Null),
        _ => Value::Null,
    };
    (reply.status, error)
}

pub fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    match value {
        Value::Object(fields) => fields.get(name),
        _ => None,
    }
}

pub async fn same_error(rust: u16, reference: u16, call: &Call<'_>) -> (Reply, Reply) {
    let mine = send(rust, call).await;
    let theirs = send(reference, call).await;
    let (my_status, my_error) = envelope_of(&mine);
    let (their_status, their_error) = envelope_of(&theirs);
    let described = format!(
        "{} {} with {}: Rust {} {}, TypeScript {} {}",
        call.method,
        call.path,
        String::from_utf8_lossy(&call.body),
        my_status,
        String::from_utf8_lossy(&mine.body),
        their_status,
        String::from_utf8_lossy(&theirs.body)
    );
    assert_eq!(my_status, their_status, "{described}");
    assert_eq!(
        field(&my_error, "code"),
        field(&their_error, "code"),
        "{described}"
    );
    assert_eq!(
        field(&my_error, "message"),
        field(&their_error, "message"),
        "{described}"
    );
    assert_eq!(
        field(&my_error, "details"),
        field(&their_error, "details"),
        "{described}"
    );
    (mine, theirs)
}

pub async fn finished_task(port: u16, accepted: &Reply) -> Value {
    assert_eq!(
        accepted.status,
        202,
        "{}",
        String::from_utf8_lossy(&accepted.body)
    );
    let Some(Value::String(id)) = field(&accepted.json(), "id").cloned() else {
        panic!("the task record has an id");
    };
    let deadline = tokio::time::Instant::now() + TASK_DEADLINE;
    loop {
        let record = send(
            port,
            &Call::new("GET", &format!("/tasks/{id}")).authorized(),
        )
        .await
        .json();
        match field(&record, "status") {
            Some(Value::String(status)) if status == "succeeded" || status == "failed" => {
                return record;
            }
            _ => {}
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the task finishes in time"
        );
        tokio::time::sleep(TASK_POLL).await;
    }
}

pub async fn rust_durable(directory: &Path, count: usize, options: ServerOptions) -> RustServer {
    let engine = durable_engine(directory);
    seed(&engine, count);
    RustServer::start(engine, options).await
}
