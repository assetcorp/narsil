#![allow(dead_code)]

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use narsil::{
    ChangesSetting, DurabilityConfig, IndexConfig, Map, Narsil, NarsilConfig, SyncSetting,
    SynonymRule, Value, decode_msgpack, encode_msgpack,
};
use narsil_server::{
    BoxError, FeedOptions, NarsilServer, RequestContext, RequestDecision, RequestDenial,
    ServerOptions,
};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::{Error as SocketError, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, client_async_with_config};

use crate::support::{
    Call, ScratchDirectory, TOKEN, decode_json, encode_json, object, repository_root, send,
};

pub const INDEX: &str = "notes";
pub const EVENT_DEADLINE: Duration = Duration::from_secs(20);
const REFERENCE_START_DEADLINE: Duration = Duration::from_secs(60);

pub type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Clone, Copy, Default)]
pub struct Setup {
    pub window_bytes: Option<u64>,
    pub max_connections: Option<u64>,
    pub grant_ms: Option<u64>,
    pub allow_regex: bool,
}

impl Setup {
    pub fn new() -> Setup {
        Setup {
            allow_regex: true,
            ..Setup::default()
        }
    }

    fn feed_options(&self) -> FeedOptions {
        FeedOptions {
            window_bytes: self.window_bytes,
            max_connections: self.max_connections,
            ..FeedOptions::default()
        }
    }

    fn feed_spec(&self) -> Value {
        let mut spec = Map::new();
        if let Some(window) = self.window_bytes {
            spec.insert("windowBytes", Value::Number(window as f64));
        }
        if let Some(maximum) = self.max_connections {
            spec.insert("maxConnections", Value::Number(maximum as f64));
        }
        Value::Object(spec)
    }
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("the clock is past 1970")
        .as_secs_f64()
        * 1_000.0
}

fn hook(grant_ms: Option<u64>) -> ServerOptions {
    let check = move |context: RequestContext| async move {
        let presented = context.headers.get("authorization").map(String::as_str);
        if presented != Some(&format!("Bearer {TOKEN}")[..]) {
            return Ok::<_, BoxError>(RequestDecision::Deny(RequestDenial {
                status: 401,
                code: "UNAUTHORIZED".to_string(),
                message: "A valid API key is required".to_string(),
            }));
        }
        Ok(match grant_ms {
            Some(grant) => RequestDecision::AllowUntil(now_ms() + grant as f64),
            None => RequestDecision::Allow,
        })
    };
    ServerOptions {
        on_request: Some(Arc::new(check)),
        ..ServerOptions::default()
    }
}

pub struct RustFeeds {
    pub server: NarsilServer,
    pub engine: Arc<Narsil>,
    pub port: u16,
    _directory: ScratchDirectory,
}

impl RustFeeds {
    pub async fn start(setup: Setup) -> RustFeeds {
        let directory = ScratchDirectory::new("feeds-rust");
        let engine = Arc::new(
            Narsil::open(NarsilConfig {
                durability: Some(DurabilityConfig {
                    directory: Some(directory.path().to_path_buf()),
                    ..DurabilityConfig::default()
                }),
                ..NarsilConfig::default()
            })
            .expect("the durable engine opens"),
        );
        let server = NarsilServer::new(
            Arc::clone(&engine),
            ServerOptions {
                port: Some(0),
                allow_regex: Some(setup.allow_regex),
                sync: Some(setup.feed_options()),
                changes: Some(setup.feed_options()),
                ..hook(setup.grant_ms)
            },
        )
        .expect("the server accepts its options");
        server.listen().await.expect("the server listens");
        let port = server
            .listening_port()
            .await
            .expect("the server has a port");
        RustFeeds {
            server,
            engine,
            port,
            _directory: directory,
        }
    }
}

pub struct ReferenceFeeds {
    pub port: u16,
    child: Child,
    _directory: ScratchDirectory,
}

impl ReferenceFeeds {
    pub async fn start(setup: Setup) -> ReferenceFeeds {
        let directory = ScratchDirectory::new("feeds-reference");
        let mut spec = Map::new();
        spec.insert("token", Value::String(TOKEN.to_string()));
        spec.insert(
            "directory",
            Value::String(directory.path().join("data").display().to_string()),
        );
        spec.insert("allowRegex", Value::Bool(setup.allow_regex));
        spec.insert("sync", setup.feed_spec());
        spec.insert("changes", setup.feed_spec());
        if let Some(grant) = setup.grant_ms {
            spec.insert("grantMs", Value::Number(grant as f64));
        }
        let spec_path = directory.path().join("spec.json");
        std::fs::write(&spec_path, encode_json(&Value::Object(spec))).expect("the spec is written");
        let script =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/feeds_support/reference_feeds.mjs");
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
        let stdout = child.stdout.take().expect("the reference has a stdout");
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
        ReferenceFeeds {
            port,
            child,
            _directory: directory,
        }
    }

    pub async fn stop(mut self) {
        drop(self.child.stdin.take());
        let _ = tokio::time::timeout(Duration::from_secs(30), self.child.wait()).await;
    }
}

pub enum Target<'a> {
    Rust(&'a RustFeeds),
    Reference(&'a ReferenceFeeds),
}

fn note(id: &str, tag: &str) -> Map {
    let mut document = Map::new();
    document.insert("title", Value::String(format!("note {id}")));
    document.insert("tag", Value::String(tag.to_string()));
    document
}

async fn expect_success(port: u16, call: Call<'_>) {
    let (method, path) = (call.method, call.path);
    let reply = send(port, &call.authorized()).await;
    assert!(
        reply.status < 300,
        "{method} {path} succeeds on the reference; it answered {} {}",
        reply.status,
        String::from_utf8_lossy(&reply.body)
    );
}

impl Target<'_> {
    pub fn port(&self) -> u16 {
        match self {
            Target::Rust(feeds) => feeds.port,
            Target::Reference(feeds) => feeds.port,
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            Target::Rust(_) => "Rust",
            Target::Reference(_) => "TypeScript",
        }
    }

    pub async fn create_index(&self, name: &str) {
        let mut schema = Map::new();
        schema.insert("title", Value::String("string".into()));
        schema.insert("tag", Value::String("enum".into()));
        match self {
            Target::Rust(feeds) => feeds
                .engine
                .create_index(
                    name,
                    IndexConfig {
                        schema: Value::Object(schema),
                        ..IndexConfig::default()
                    },
                )
                .expect("the index is created"),
            Target::Reference(feeds) => {
                let body = object(vec![
                    ("name", Value::String(name.to_string())),
                    ("config", object(vec![("schema", Value::Object(schema))])),
                ]);
                expect_success(feeds.port, Call::new("POST", "/indexes").json(&body)).await;
            }
        }
    }

    pub async fn set_sync(&self, enabled: bool) {
        match self {
            Target::Rust(feeds) => feeds
                .engine
                .update_sync(
                    INDEX,
                    &SyncSetting {
                        enabled,
                        history_max_age_ms: None,
                        history_max_bytes: None,
                    },
                )
                .expect("the sync setting changes"),
            Target::Reference(feeds) => {
                let body = object(vec![("enabled", Value::Bool(enabled))]);
                let path = format!("/indexes/{INDEX}/sync");
                expect_success(feeds.port, Call::new("PUT", &path).json(&body)).await;
            }
        }
    }

    pub async fn set_changes(&self, enabled: bool, previous_document: bool) {
        match self {
            Target::Rust(feeds) => feeds
                .engine
                .update_changes(
                    INDEX,
                    &ChangesSetting {
                        enabled,
                        previous_document,
                        history_max_age_ms: None,
                        history_max_bytes: None,
                    },
                )
                .expect("the change capture setting changes"),
            Target::Reference(feeds) => {
                let body = object(vec![
                    ("enabled", Value::Bool(enabled)),
                    ("previousDocument", Value::Bool(previous_document)),
                ]);
                let path = format!("/indexes/{INDEX}/changes");
                expect_success(feeds.port, Call::new("PUT", &path).json(&body)).await;
            }
        }
    }

    pub async fn insert(&self, id: &str, tag: &str) {
        match self {
            Target::Rust(feeds) => {
                feeds
                    .engine
                    .insert(INDEX, note(id, tag), Some(id))
                    .expect("the document is inserted");
            }
            Target::Reference(feeds) => {
                let body = object(vec![
                    ("document", Value::Object(note(id, tag))),
                    ("id", Value::String(id.to_string())),
                ]);
                let path = format!("/indexes/{INDEX}/documents");
                expect_success(feeds.port, Call::new("POST", &path).json(&body)).await;
            }
        }
    }

    pub async fn clear(&self) {
        match self {
            Target::Rust(feeds) => feeds.engine.clear(INDEX).expect("the index clears"),
            Target::Reference(feeds) => {
                let path = format!("/indexes/{INDEX}/_clear");
                expect_success(feeds.port, Call::new("POST", &path)).await;
            }
        }
    }

    pub async fn drop_index(&self) {
        match self {
            Target::Rust(feeds) => feeds.engine.drop_index(INDEX).expect("the index drops"),
            Target::Reference(feeds) => {
                let path = format!("/indexes/{INDEX}");
                expect_success(feeds.port, Call::new("DELETE", &path)).await;
            }
        }
    }

    pub async fn add_synonyms(&self) {
        match self {
            Target::Rust(feeds) => feeds
                .engine
                .update_synonyms(
                    INDEX,
                    &[SynonymRule::TwoWay(vec!["note".into(), "memo".into()])],
                )
                .expect("the synonyms change"),
            Target::Reference(feeds) => {
                let rule = object(vec![(
                    "words",
                    Value::Array(vec![
                        Value::String("note".into()),
                        Value::String("memo".into()),
                    ]),
                )]);
                let body = object(vec![("synonyms", Value::Array(vec![rule]))]);
                let path = format!("/indexes/{INDEX}/synonyms");
                expect_success(feeds.port, Call::new("POST", &path).json(&body)).await;
            }
        }
    }

    pub async fn sync_epoch(&self) -> String {
        match self {
            Target::Rust(feeds) => feeds
                .engine
                .get_sync(INDEX)
                .expect("the sync status reads")
                .epoch
                .expect("sync is on"),
            Target::Reference(feeds) => {
                let path = format!("/indexes/{INDEX}/sync");
                let reply = send(feeds.port, &Call::new("GET", &path).authorized()).await;
                match reply.json() {
                    Value::Object(status) => match status.get("epoch") {
                        Some(Value::String(epoch)) => epoch.clone(),
                        _ => panic!("the reference sync status holds an epoch"),
                    },
                    _ => panic!("the reference sync status is an object"),
                }
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Message(Value),
    Closed(Option<(u16, String)>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Refusal {
    pub status: u16,
    pub body: Value,
}

pub enum Offer<'a> {
    Subprotocol(&'a str),
    Nothing,
}

pub async fn open(
    port: u16,
    path: &str,
    offer: Offer<'_>,
    authorized: bool,
) -> Result<Socket, Refusal> {
    let mut request = format!("ws://127.0.0.1:{port}{path}")
        .into_client_request()
        .expect("the feed address is well formed");
    if let Offer::Subprotocol(subprotocol) = offer {
        request.headers_mut().insert(
            "sec-websocket-protocol",
            HeaderValue::from_str(subprotocol).expect("the subprotocol is a header value"),
        );
    }
    if authorized {
        request.headers_mut().insert(
            "authorization",
            HeaderValue::from_str(&format!("Bearer {TOKEN}")).expect("the token is a header value"),
        );
    }
    let stream = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("the server accepts a connection");
    let config = WebSocketConfig::default().max_message_size(Some(64 << 20));
    match client_async_with_config(request, MaybeTlsStream::Plain(stream), Some(config)).await {
        Ok((socket, _)) => Ok(socket),
        Err(SocketError::Http(response)) => {
            let status = response.status().as_u16();
            let body = response
                .body()
                .as_ref()
                .map(|bytes| {
                    let text = String::from_utf8_lossy(bytes).into_owned();
                    decode_json(&text).unwrap_or(Value::String(text))
                })
                .unwrap_or(Value::Null);
            Err(Refusal { status, body })
        }
        Err(other) => panic!("the WebSocket handshake fails with {other}"),
    }
}

pub async fn subscribe_socket(port: u16, path: &str, subprotocol: &str) -> Socket {
    open(port, path, Offer::Subprotocol(subprotocol), true)
        .await
        .expect("the server upgrades the feed")
}

pub async fn send_value(socket: &mut Socket, value: &Value) {
    let bytes = encode_msgpack(value).expect("the message encodes");
    let _ = socket.send(Message::Binary(Bytes::from(bytes))).await;
}

pub async fn send_raw(socket: &mut Socket, message: Message) {
    let _ = socket.send(message).await;
}

pub async fn next_event(socket: &mut Socket) -> Event {
    loop {
        let frame = match tokio::time::timeout(EVENT_DEADLINE, socket.next()).await {
            Ok(frame) => frame,
            Err(_) => panic!("the feed answers within {EVENT_DEADLINE:?}"),
        };
        match frame {
            Some(Ok(Message::Binary(bytes))) => {
                return Event::Message(decode_msgpack(&bytes).expect("the feed sends MessagePack"));
            }
            Some(Ok(Message::Close(frame))) => {
                return Event::Closed(
                    frame.map(|frame| (u16::from(frame.code), frame.reason.as_str().to_string())),
                );
            }
            Some(Ok(_)) => continue,
            Some(Err(_)) | None => return Event::Closed(None),
        }
    }
}

pub async fn quiet_for(socket: &mut Socket, wait: Duration) -> Option<Event> {
    tokio::time::timeout(wait, next_event(socket)).await.ok()
}

pub async fn until_closed(socket: &mut Socket) -> (Vec<Value>, Option<(u16, String)>) {
    let mut messages = Vec::new();
    loop {
        match next_event(socket).await {
            Event::Message(message) => messages.push(message),
            Event::Closed(close) => return (messages, close),
        }
    }
}

pub fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    match value {
        Value::Object(map) => map.get(key),
        _ => None,
    }
}

pub fn kind_of(value: &Value) -> String {
    match field(value, "type") {
        Some(Value::String(kind)) => kind.clone(),
        _ => String::new(),
    }
}

pub fn number(value: &Value, key: &str) -> f64 {
    match field(value, key) {
        Some(Value::Number(number)) => *number,
        _ => panic!("{key} is a number in {value:?}"),
    }
}

pub fn text(value: &Value, key: &str) -> String {
    match field(value, key) {
        Some(Value::String(text)) => text.clone(),
        _ => panic!("{key} is a string in {value:?}"),
    }
}

pub fn list<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    match field(value, key) {
        Some(Value::Array(items)) => items,
        _ => panic!("{key} is a list in {value:?}"),
    }
}

pub fn positions(seq_nos: &[u64]) -> Value {
    Value::Array(
        seq_nos
            .iter()
            .enumerate()
            .map(|(partition, seq_no)| {
                object(vec![
                    ("partitionId", Value::Number(partition as f64)),
                    ("seqNo", Value::Number(*seq_no as f64)),
                ])
            })
            .collect(),
    )
}

pub fn ack(seq_nos: &[u64]) -> Value {
    object(vec![
        ("type", Value::String("ack".into())),
        ("positions", positions(seq_nos)),
    ])
}

pub fn refusal_parts(refusal: &Refusal) -> (u16, Value) {
    let error = field(&refusal.body, "error")
        .cloned()
        .unwrap_or(Value::Null);
    (refusal.status, error)
}
