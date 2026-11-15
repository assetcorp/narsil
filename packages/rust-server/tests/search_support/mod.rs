#![allow(dead_code)]

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use narsil::{
    IndexConfig, Map, Narsil, NarsilConfig, QuerySuggestionsConfig, Value, write_plain_json,
};
use narsil_server::{BoxError, QueryIdentity, RequestContext, ServerLimits, ServerOptions};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use crate::support::{RustServer, ScratchDirectory, object, repository_root};

pub const INDEX: &str = "books";
pub const SUGGESTIONS_KEY: &str = "a suggestions key of at least thirty-two bytes";
const WORDS: [&str; 8] = [
    "river", "stone", "quiet", "harbor", "lantern", "winter", "garden", "signal",
];
const GENRES: [&str; 3] = ["fiction", "science", "history"];
const REFERENCE_START_DEADLINE: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq)]
pub struct Book {
    pub id: String,
    pub title: String,
    pub year: f64,
    pub genre: &'static str,
    pub tags: Vec<&'static str>,
    pub price: f64,
}

impl Book {
    pub fn document(&self) -> Map {
        let mut map = Map::new();
        map.insert("title", Value::String(self.title.clone()));
        map.insert("year", Value::Number(self.year));
        map.insert("genre", Value::String(self.genre.to_string()));
        map.insert(
            "tags",
            Value::Array(
                self.tags
                    .iter()
                    .map(|tag| Value::String((*tag).to_string()))
                    .collect(),
            ),
        );
        map.insert("price", Value::Number(self.price));
        map
    }
}

pub fn books(count: usize) -> Vec<Book> {
    (0..count)
        .map(|at| Book {
            id: format!("book-{at:03}"),
            title: format!(
                "{} {} {}",
                WORDS[at % 8],
                WORDS[(at * 3 + 1) % 8],
                WORDS[(at * 5 + 2) % 8]
            ),
            year: (1990 + (at * 7) % 30) as f64,
            genre: GENRES[at % 3],
            tags: vec![WORDS[at % 8], WORDS[(at + 2) % 8]],
            price: ((at * 37) % 100) as f64 + 0.5,
        })
        .collect()
}

pub fn schema() -> Value {
    object(vec![
        ("title", Value::String("string".to_string())),
        ("year", Value::String("number".to_string())),
        ("genre", Value::String("enum".to_string())),
        ("tags", Value::String("string[]".to_string())),
        ("price", Value::String("number".to_string())),
    ])
}

#[derive(Debug, Clone, Default)]
pub struct Setup {
    pub books: usize,
    pub max_result_window: Option<u64>,
    pub max_fetch_documents: Option<u64>,
    pub max_rerank_window: Option<u64>,
    pub refuse_regex: bool,
    pub suggestions: bool,
    pub identify: bool,
}

fn header(context: &RequestContext, name: &str) -> Option<String> {
    context.headers.get(name).cloned()
}

async fn identify(context: RequestContext) -> Result<Option<QueryIdentity>, BoxError> {
    let mode = header(&context, "x-identify");
    match mode.as_deref() {
        Some("fail") => return Err("the identity store is down".into()),
        Some("panic") => panic!("the identify function panics"),
        Some("half") => {
            return Ok(Some(QueryIdentity {
                person: header(&context, "x-person"),
                group: None,
            }));
        }
        _ => {}
    }
    let Some(person) = header(&context, "x-person") else {
        return Ok(None);
    };
    Ok(Some(QueryIdentity {
        person: Some(person),
        group: Some(header(&context, "x-group").unwrap_or_else(|| "everyone".to_string())),
    }))
}

impl Setup {
    fn engine(&self) -> Narsil {
        let engine = Narsil::open(NarsilConfig {
            query_suggestions: self.suggestions.then(|| QuerySuggestionsConfig {
                key: SUGGESTIONS_KEY.as_bytes().to_vec(),
            }),
            ..NarsilConfig::default()
        })
        .expect("the engine opens");
        engine
            .create_index(
                INDEX,
                IndexConfig {
                    schema: schema(),
                    ..IndexConfig::default()
                },
            )
            .expect("the index is created");
        for book in books(self.books) {
            engine
                .insert(INDEX, book.document(), Some(&book.id))
                .expect("the book is stored");
        }
        engine
    }

    pub async fn rust(&self) -> RustServer {
        let options = ServerOptions {
            limits: ServerLimits {
                max_result_window: self.max_result_window,
                max_fetch_documents: self.max_fetch_documents,
                max_rerank_window: self.max_rerank_window,
                ..ServerLimits::default()
            },
            allow_regex: Some(!self.refuse_regex),
            query_suggestions_identify: self
                .identify
                .then(|| Arc::new(identify) as Arc<dyn narsil_server::QueryIdentify>),
            ..ServerOptions::default()
        };
        RustServer::start(self.engine(), options).await
    }

    fn spec(&self) -> Value {
        let mut limits = Map::new();
        let numbers = [
            ("maxResultWindow", self.max_result_window),
            ("maxFetchDocuments", self.max_fetch_documents),
            ("maxRerankWindow", self.max_rerank_window),
        ];
        for (key, limit) in numbers {
            if let Some(limit) = limit {
                limits.insert(key, Value::Number(limit as f64));
            }
        }
        let documents = books(self.books)
            .into_iter()
            .map(|book| {
                object(vec![
                    ("id", Value::String(book.id.clone())),
                    ("document", Value::Object(book.document())),
                ])
            })
            .collect();
        let mut spec = Map::new();
        spec.insert("limits", Value::Object(limits));
        spec.insert("allowRegex", Value::Bool(!self.refuse_regex));
        spec.insert("identify", Value::Bool(self.identify));
        if self.suggestions {
            spec.insert("suggestionsKey", Value::String(SUGGESTIONS_KEY.to_string()));
        }
        spec.insert(
            "indexes",
            Value::Array(vec![object(vec![
                ("name", Value::String(INDEX.to_string())),
                ("schema", schema()),
                ("documents", Value::Array(documents)),
            ])]),
        );
        Value::Object(spec)
    }

    pub async fn reference(&self) -> ReferenceSearchServer {
        ReferenceSearchServer::start(self.spec()).await
    }
}

pub struct ReferenceSearchServer {
    pub port: u16,
    child: Child,
    _spec: ScratchDirectory,
}

impl ReferenceSearchServer {
    async fn start(spec: Value) -> ReferenceSearchServer {
        let scratch = ScratchDirectory::new("reference-search-spec");
        let spec_path = scratch.path().join("spec.json");
        std::fs::write(&spec_path, write_plain_json(&spec)).expect("the spec is written");
        let script = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/search_support/reference_search_server.mjs");
        let mut child = Command::new("node")
            .arg(script)
            .arg(repository_root())
            .arg(&spec_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .expect("node starts the TypeScript reference server");
        let stdout = child
            .stdout
            .take()
            .expect("the reference server has a stdout");
        let mut lines = BufReader::new(stdout).lines();
        let ready = tokio::time::timeout(REFERENCE_START_DEADLINE, lines.next_line())
            .await
            .expect("the reference server starts in time; build packages/ts first")
            .expect("the reference server writes a line")
            .expect("the reference server writes READY");
        let port = ready
            .strip_prefix("READY ")
            .and_then(|port| port.parse().ok())
            .expect("the reference server gives its port");
        ReferenceSearchServer {
            port,
            child,
            _spec: scratch,
        }
    }

    pub async fn stop(mut self) {
        drop(self.child.stdin.take());
        let _ = tokio::time::timeout(Duration::from_secs(30), self.child.wait()).await;
    }
}

pub fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    match value {
        Value::Object(map) => map.get(key).unwrap_or(&Value::Null),
        _ => &Value::Null,
    }
}

pub fn items(value: &Value) -> &[Value] {
    match value {
        Value::Array(items) => items,
        _ => &[],
    }
}

pub fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}

pub fn ids(answer: &Value, key: &str) -> Vec<String> {
    items(field(answer, key))
        .iter()
        .map(|item| text(field(item, "id")).to_string())
        .collect()
}

pub fn without_elapsed(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().filter(|key| *key != "elapsed").collect();
            keys.sort();
            let mut kept = Map::new();
            for key in keys {
                kept.insert(key.clone(), without_elapsed(field(value, key)));
            }
            Value::Object(kept)
        }
        Value::Array(items) => Value::Array(items.iter().map(without_elapsed).collect()),
        other => other.clone(),
    }
}

pub fn error_message(value: &Value) -> String {
    text(field(field(value, "error"), "message")).to_string()
}
