#![allow(dead_code)]

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use narsil::{Map, Value, parse_plain_json, write_plain_json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use crate::data_node::free_port;

const START_WAIT: Duration = Duration::from_secs(60);
const ANSWER_WAIT: Duration = Duration::from_secs(90);
const SHUTDOWN_WAIT: Duration = Duration::from_secs(30);

pub struct TypescriptNode {
    pub node_id: String,
    pub address: String,
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Lines<BufReader<ChildStdout>>,
    next_request: u64,
}

#[derive(Debug)]
pub enum Answer {
    Value(Value),
    Refused { code: String, message: String },
}

impl Answer {
    pub fn value(self) -> Value {
        match self {
            Answer::Value(value) => value,
            Answer::Refused { code, message } => {
                panic!("the TypeScript node refused the call with {code}: {message}")
            }
        }
    }

    pub fn code(&self) -> Option<&str> {
        match self {
            Answer::Value(_) => None,
            Answer::Refused { code, .. } => Some(code),
        }
    }
}

pub fn fields<const N: usize>(entries: [(&str, Value); N]) -> Map {
    entries.into_iter().collect()
}

pub fn title_document(title: &str) -> Value {
    Value::Object(fields([("title", Value::from(title))]))
}

impl TypescriptNode {
    pub async fn start(
        endpoint: &str,
        key_prefix: &str,
        node_id: &str,
        roles: &str,
    ) -> TypescriptNode {
        TypescriptNode::start_with_heartbeat_ttl(endpoint, key_prefix, node_id, roles, None).await
    }

    pub async fn start_with_heartbeat_ttl(
        endpoint: &str,
        key_prefix: &str,
        node_id: &str,
        roles: &str,
        heartbeat_ttl_seconds: Option<u64>,
    ) -> TypescriptNode {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let port = free_port();
        let mut child = Command::new("node")
            .arg(manifest.join("tests/support/typescript_node.mjs"))
            .arg(manifest.join("../.."))
            .args([endpoint, key_prefix, node_id, roles, &port.to_string()])
            .args(heartbeat_ttl_seconds.map(|seconds| seconds.to_string()))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("node starts the TypeScript cluster node");
        let stdout = child.stdout.take().expect("the node's stdout is piped");
        let stdin = child.stdin.take().expect("the node's stdin is piped");
        let mut lines = BufReader::new(stdout).lines();
        let ready = tokio::time::timeout(START_WAIT, lines.next_line())
            .await
            .expect("the TypeScript node joined in time")
            .expect("the node's stdout is readable")
            .expect("the node printed a line before it exited; build packages/ts first");
        assert_eq!(
            ready.trim(),
            "READY",
            "the TypeScript node announces that it joined"
        );
        TypescriptNode {
            node_id: node_id.to_string(),
            address: format!("127.0.0.1:{port}"),
            child,
            stdin: Some(stdin),
            lines,
            next_request: 0,
        }
    }

    pub async fn call(&mut self, operation: &str, mut request: Map) -> Answer {
        self.next_request += 1;
        let id = self.next_request;
        request.insert("id", Value::from(id));
        request.insert("op", Value::from(operation));
        let mut line = write_plain_json(&Value::Object(request));
        line.push('\n');
        let stdin = self
            .stdin
            .as_mut()
            .expect("the node takes calls until it shuts down");
        stdin
            .write_all(line.as_bytes())
            .await
            .expect("the node reads its calls");
        let answered = tokio::time::timeout(ANSWER_WAIT, self.lines.next_line())
            .await
            .unwrap_or_else(|_| panic!("the TypeScript node answered {operation} in time"))
            .expect("the node's stdout is readable")
            .expect("the node answered before it exited");
        let Ok(Value::Object(answer)) = parse_plain_json(&answered) else {
            panic!("the TypeScript node answered with JSON: {answered}");
        };
        assert_eq!(answer.get("id"), Some(&Value::from(id)), "{answered}");
        if answer.get("ok") == Some(&Value::Bool(true)) {
            return Answer::Value(answer.get("value").cloned().unwrap_or(Value::Null));
        }
        let text = |key: &str| {
            answer
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        Answer::Refused {
            code: text("code"),
            message: text("message"),
        }
    }

    pub async fn create_index(
        &mut self,
        index_name: &str,
        partitions: u64,
        replication_factor: u64,
    ) {
        let schema = Value::Object(fields([("title", Value::from("string"))]));
        self.call(
            "createIndex",
            fields([
                ("indexName", Value::from(index_name)),
                ("schema", schema),
                ("partitionCount", Value::from(partitions)),
                ("replicationFactor", Value::from(replication_factor)),
            ]),
        )
        .await
        .value();
    }

    pub async fn insert(&mut self, index_name: &str, document_id: &str, title: &str) -> Answer {
        self.call(
            "insert",
            fields([
                ("indexName", Value::from(index_name)),
                ("documentId", Value::from(document_id)),
                ("document", title_document(title)),
            ]),
        )
        .await
    }

    pub async fn update(&mut self, index_name: &str, document_id: &str, title: &str) -> Answer {
        self.call(
            "update",
            fields([
                ("indexName", Value::from(index_name)),
                ("documentId", Value::from(document_id)),
                ("document", title_document(title)),
            ]),
        )
        .await
    }

    pub async fn remove(&mut self, index_name: &str, document_id: &str) -> Answer {
        self.call(
            "remove",
            fields([
                ("indexName", Value::from(index_name)),
                ("documentId", Value::from(document_id)),
            ]),
        )
        .await
    }

    pub async fn title(&mut self, index_name: &str, document_id: &str) -> Option<String> {
        let held = self
            .call(
                "get",
                fields([
                    ("indexName", Value::from(index_name)),
                    ("documentId", Value::from(document_id)),
                ]),
            )
            .await
            .value();
        match held {
            Value::Null => None,
            Value::Object(document) => document
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_string),
            other => panic!("the TypeScript node read {document_id} as {other:?}"),
        }
    }

    pub async fn partition_counts(&mut self, index_name: &str) -> Vec<(u32, u64)> {
        let Value::Array(entries) = self
            .call(
                "partitionCounts",
                fields([("indexName", Value::from(index_name))]),
            )
            .await
            .value()
        else {
            panic!("the TypeScript node lists the partitions");
        };
        entries
            .iter()
            .map(|entry| {
                let number = |key: &str| match entry {
                    Value::Object(fields) => match fields.get(key) {
                        Some(Value::Number(number)) => *number,
                        _ => panic!("a partition entry carries {key}: {entry:?}"),
                    },
                    _ => panic!("a partition entry is an object: {entry:?}"),
                };
                (number("partitionId") as u32, number("documentCount") as u64)
            })
            .collect()
    }

    pub async fn kill(mut self) {
        self.child
            .kill()
            .await
            .expect("the TypeScript node's process is killed");
    }

    pub async fn shutdown(mut self) {
        drop(self.stdin.take());
        let exited = tokio::time::timeout(SHUTDOWN_WAIT, self.child.wait()).await;
        if !matches!(exited, Ok(Ok(status)) if status.success()) {
            let _ = self.child.kill().await;
            panic!("the TypeScript node shuts down cleanly: {exited:?}");
        }
    }
}
