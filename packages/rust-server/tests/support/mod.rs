#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::Request;
use hyper_util::rt::TokioIo;
use narsil::{Map, Narsil, NarsilConfig, Value, parse_plain_json, write_plain_json};
use narsil_server::{
    BoxError, NarsilServer, RequestContext, RequestDecision, RequestDenial, ServerOptions,
};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::{Child, Command};

pub const TOKEN: &str = "test-token";
const REFERENCE_START_DEADLINE: Duration = Duration::from_secs(60);

static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);

pub fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the repository root exists")
}

pub struct ScratchDirectory {
    path: PathBuf,
}

impl ScratchDirectory {
    pub fn new(label: &str) -> ScratchDirectory {
        let serial = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "narsil-rust-server-{label}-{}-{serial}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("the scratch directory is created");
        ScratchDirectory { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for ScratchDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

pub fn token_hook(options: ServerOptions) -> ServerOptions {
    let hook = |context: RequestContext| async move {
        let presented = context.headers.get("authorization").map(String::as_str);
        Ok::<_, BoxError>(if presented == Some(&format!("Bearer {TOKEN}")[..]) {
            RequestDecision::Allow
        } else {
            RequestDecision::Deny(RequestDenial {
                status: 401,
                code: "UNAUTHORIZED".to_string(),
                message: "A valid API key is required".to_string(),
            })
        })
    };
    ServerOptions {
        on_request: Some(Arc::new(hook)),
        ..options
    }
}

pub struct RustServer {
    pub server: NarsilServer,
    pub port: u16,
}

impl RustServer {
    pub async fn start(engine: Narsil, options: ServerOptions) -> RustServer {
        let server = NarsilServer::new(
            Arc::new(engine),
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
        RustServer { server, port }
    }

    pub async fn in_memory(options: ServerOptions) -> RustServer {
        RustServer::start(Narsil::new(), options).await
    }

    pub async fn durable(directory: &Path, options: ServerOptions) -> RustServer {
        let engine = Narsil::open(NarsilConfig {
            durability: Some(narsil::DurabilityConfig {
                directory: Some(directory.to_path_buf()),
                ..narsil::DurabilityConfig::default()
            }),
            ..NarsilConfig::default()
        })
        .expect("the durable engine opens");
        RustServer::start(engine, options).await
    }

    pub async fn stop(self) {
        self.server.shutdown().await.expect("the server shuts down");
    }
}

pub struct ReferenceServer {
    pub port: u16,
    child: Child,
    _spec: ScratchDirectory,
}

impl ReferenceServer {
    pub async fn start(spec: Value) -> ReferenceServer {
        let scratch = ScratchDirectory::new("reference-spec");
        let spec_path = scratch.path().join("spec.json");
        std::fs::write(&spec_path, write_plain_json(&spec)).expect("the spec is written");
        let script =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/reference_server.mjs");
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
            .expect("the reference server names its port");
        ReferenceServer {
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

#[derive(Debug, Clone)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Bytes,
}

impl Reply {
    pub fn json(&self) -> Value {
        parse_plain_json(&String::from_utf8_lossy(&self.body)).unwrap_or(Value::Null)
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    pub fn error_code(&self) -> Option<String> {
        match self.json() {
            Value::Object(body) => match body.get("error") {
                Some(Value::Object(error)) => match error.get("code") {
                    Some(Value::String(code)) => Some(code.clone()),
                    _ => None,
                },
                _ => None,
            },
            _ => None,
        }
    }
}

pub struct Call<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub headers: Vec<(&'a str, String)>,
    pub body: Bytes,
}

impl<'a> Call<'a> {
    pub fn new(method: &'a str, path: &'a str) -> Call<'a> {
        Call {
            method,
            path,
            headers: Vec::new(),
            body: Bytes::new(),
        }
    }

    pub fn authorized(mut self) -> Call<'a> {
        self.headers
            .push(("authorization", format!("Bearer {TOKEN}")));
        self
    }

    pub fn header(mut self, name: &'a str, value: impl Into<String>) -> Call<'a> {
        self.headers.push((name, value.into()));
        self
    }

    pub fn json(mut self, body: &Value) -> Call<'a> {
        self.headers
            .push(("content-type", "application/json".to_string()));
        self.body = Bytes::from(write_plain_json(body));
        self
    }

    pub fn raw(mut self, body: impl Into<Bytes>) -> Call<'a> {
        self.body = body.into();
        self
    }
}

pub async fn send(port: u16, call: &Call<'_>) -> Reply {
    let stream = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("the server accepts a connection");
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .expect("the HTTP handshake succeeds");
    tokio::spawn(connection);
    let mut request = Request::builder()
        .method(call.method)
        .uri(call.path)
        .header("host", format!("127.0.0.1:{port}"));
    for (name, value) in &call.headers {
        request = request.header(*name, value);
    }
    let request = request
        .body(Full::new(call.body.clone()))
        .expect("the request is well formed");
    let response = sender
        .send_request(request)
        .await
        .expect("the server answers");
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_string(),
                String::from_utf8_lossy(value.as_bytes()).into_owned(),
            )
        })
        .collect();
    let body = response
        .into_body()
        .collect()
        .await
        .expect("the body arrives")
        .to_bytes();
    Reply {
        status,
        headers,
        body,
    }
}

pub fn object(entries: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    for (key, value) in entries {
        map.insert(key, value);
    }
    Value::Object(map)
}

pub fn parsed(text: &str) -> Value {
    parse_plain_json(text).expect("the test JSON is well formed")
}

pub async fn same_status_and_code(rust: u16, reference: u16, call: &Call<'_>) -> (Reply, Reply) {
    let mine = send(rust, call).await;
    let theirs = send(reference, call).await;
    assert_eq!(
        (mine.status, mine.error_code()),
        (theirs.status, theirs.error_code()),
        "{} {} answers as the TypeScript server does; Rust body {}, TypeScript body {}",
        call.method,
        call.path,
        String::from_utf8_lossy(&mine.body),
        String::from_utf8_lossy(&theirs.body)
    );
    (mine, theirs)
}
