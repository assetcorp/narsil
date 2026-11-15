#![allow(dead_code)]

use std::sync::Arc;
use std::time::Duration;

use narsil::{IndexConfig, Map, Narsil, Value, parse_plain_json};
use narsil_server::{NarsilServer, ServerOptions};

use crate::support::{Call, object, parsed, send};

const TASK_DEADLINE: Duration = Duration::from_secs(120);
const TASK_POLL_INTERVAL: Duration = Duration::from_millis(20);

pub struct Served {
    pub server: NarsilServer,
    pub engine: Arc<Narsil>,
    pub port: u16,
}

impl Served {
    pub async fn start(engine: Narsil, options: ServerOptions) -> Served {
        let engine = Arc::new(engine);
        let server = NarsilServer::new(
            Arc::clone(&engine),
            ServerOptions {
                port: Some(0),
                ..options
            },
        )
        .expect("the server accepts its options");
        server.listen().await.expect("the server listens");
        let port = server
            .listening_port()
            .await
            .expect("the server has a port");
        Served {
            server,
            engine,
            port,
        }
    }

    pub async fn stop(self) {
        self.server.shutdown().await.expect("the server shuts down");
    }
}

pub const ARTICLE_SCHEMA: &str = r#"{"title":"string","views":"number"}"#;

pub fn create_in_engine(engine: &Narsil, name: &str, schema: &str) {
    engine
        .create_index(
            name,
            IndexConfig {
                schema: parsed(schema),
                ..IndexConfig::default()
            },
        )
        .expect("the engine creates the index");
}

pub async fn create_over_http(port: u16, name: &str, schema: &str) {
    let body = object(vec![
        ("name", Value::String(name.to_string())),
        ("config", object(vec![("schema", parsed(schema))])),
    ]);
    let reply = send(port, &Call::new("POST", "/indexes").json(&body)).await;
    assert!(
        reply.status < 300,
        "the reference server creates index {name}: {}",
        String::from_utf8_lossy(&reply.body)
    );
}

pub fn at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in path {
        current = match current {
            Value::Object(fields) => fields.get(key)?,
            _ => return None,
        };
    }
    Some(current)
}

pub fn text_at(value: &Value, path: &[&str]) -> Option<String> {
    at(value, path).and_then(Value::as_str).map(str::to_string)
}

pub fn number_at(value: &Value, path: &[&str]) -> Option<f64> {
    match at(value, path) {
        Some(Value::Number(number)) => Some(*number),
        _ => None,
    }
}

pub fn keys_of(value: &Value) -> Vec<String> {
    match value {
        Value::Object(fields) => {
            let mut keys: Vec<String> = fields.keys().cloned().collect();
            keys.sort();
            keys
        }
        _ => Vec::new(),
    }
}

pub fn without(value: &Value, dropped: &[&str]) -> Value {
    match value {
        Value::Object(fields) => {
            let mut kept = Map::new();
            for (key, field) in fields.iter() {
                if !dropped.contains(&key.as_str()) {
                    kept.insert(key.clone(), field.clone());
                }
            }
            Value::Object(kept)
        }
        other => other.clone(),
    }
}

pub fn without_engine_details(value: &Value) -> Value {
    match value {
        Value::Object(fields) => {
            let mut kept = Map::new();
            for (key, field) in fields.iter() {
                if key != "details" {
                    kept.insert(key.clone(), without_engine_details(field));
                }
            }
            Value::Object(kept)
        }
        Value::Array(entries) => Value::Array(entries.iter().map(without_engine_details).collect()),
        other => other.clone(),
    }
}

pub async fn wait_for_task(port: u16, id: &str) -> Value {
    let path = format!("/tasks/{id}");
    let deadline = tokio::time::Instant::now() + TASK_DEADLINE;
    loop {
        let reply = send(port, &Call::new("GET", &path)).await;
        assert_eq!(reply.status, 200, "task {id} stays readable");
        let record = reply.json();
        if text_at(&record, &["status"]).as_deref() != Some("running") {
            return record;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "task {id} finishes in time"
        );
        tokio::time::sleep(TASK_POLL_INTERVAL).await;
    }
}

pub async fn wait_for_progress(port: u16, id: &str, least_indexed: f64) -> Value {
    let path = format!("/tasks/{id}");
    let deadline = tokio::time::Instant::now() + TASK_DEADLINE;
    loop {
        let record = send(port, &Call::new("GET", &path)).await.json();
        let indexed = number_at(&record, &["progress", "indexed"]).unwrap_or(0.0);
        if indexed >= least_indexed || text_at(&record, &["status"]).as_deref() != Some("running") {
            return record;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "task {id} reports progress in time"
        );
        tokio::time::sleep(TASK_POLL_INTERVAL).await;
    }
}

pub fn article_lines(count: usize) -> Vec<String> {
    (0..count)
        .map(|serial| {
            format!(
                r#"{{"id":"article-{serial}","title":"Field notes {serial}","views":{serial}}}"#
            )
        })
        .collect()
}

pub fn ndjson(lines: &[String]) -> String {
    let mut body = lines.join("\n");
    body.push('\n');
    body
}

pub fn ndjson_call<'a>(path: &'a str, body: &str) -> Call<'a> {
    Call::new("POST", path)
        .header("content-type", "application/x-ndjson")
        .raw(body.to_string())
}

pub fn stored_ids(engine: &Narsil, index: &str, candidates: &[String]) -> Vec<String> {
    candidates
        .iter()
        .filter(|id| matches!(engine.get(index, id), Ok(Some(_))))
        .cloned()
        .collect()
}

pub fn json_of(text: &str) -> Value {
    parse_plain_json(text).expect("the line is JSON")
}
