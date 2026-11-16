mod support;

use std::fmt::Write as _;
use std::time::{Duration, Instant};

use narsil::{IndexConfig, Narsil, Value};
use narsil_server::ServerOptions;
use support::{Call, ReferenceServer, RustServer, object, parsed, send};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpSocket, TcpStream};

const SCHEMA: &str = r#"{"title":"string"}"#;
const STALLED_READER_RECEIVE_BUFFER_BYTES: u32 = 64 * 1024;
const IDLE_CLOSE_WITHIN: Duration = Duration::from_secs(20);
const TRICKLE_INTERVAL: Duration = Duration::from_secs(1);
const TRICKLE_DECLARED_BYTES: usize = 100_000;
const STALLED_READER_PAUSE: Duration = Duration::from_secs(20);
const DRAIN_WITHIN: Duration = Duration::from_secs(60);
const SLOW_READER_RECEIVE_BUFFER_BYTES: u32 = 32 * 1024;
const SLOW_READER_READ_BYTES: usize = 32 * 1024;
const SLOW_READER_READ_INTERVAL: Duration = Duration::from_secs(5);
const SLOW_READER_PAUSE: Duration = Duration::from_secs(25);
const EXPORT_DOCUMENTS: usize = 10_000;
const TITLE_BYTES: usize = 4_000;

struct Servers {
    rust: RustServer,
    reference: ReferenceServer,
}

impl Servers {
    async fn start() -> Servers {
        let engine = Narsil::new();
        engine
            .create_index(
                "articles",
                IndexConfig {
                    schema: parsed(SCHEMA),
                    ..IndexConfig::default()
                },
            )
            .expect("the engine creates the index");
        let rust = RustServer::start(engine, ServerOptions::default()).await;
        let reference = ReferenceServer::start(object(vec![])).await;
        let created = send(
            reference.port,
            &Call::new("POST", "/indexes").json(&object(vec![
                ("name", Value::from("articles")),
                ("config", object(vec![("schema", parsed(SCHEMA))])),
            ])),
        )
        .await;
        assert!(
            created.status < 300,
            "the reference server creates the index"
        );
        Servers { rust, reference }
    }

    fn ports(&self) -> [(&'static str, u16); 2] {
        [
            ("Rust", self.rust.port),
            ("TypeScript", self.reference.port),
        ]
    }

    async fn stop(self) {
        self.reference.stop().await;
        self.rust.stop().await;
    }
}

async fn connect(port: u16) -> TcpStream {
    TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("the server accepts a connection")
}

async fn read_until_closed(stream: &mut TcpStream, within: Duration) -> Option<usize> {
    let mut received = 0;
    let mut buffer = vec![0; 64 * 1024];
    let deadline = Instant::now() + within;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(left, stream.read(&mut buffer)).await {
            Err(_) => return None,
            Ok(Ok(0)) | Ok(Err(_)) => return Some(received),
            Ok(Ok(read)) => received += read,
        }
    }
}

async fn silent_client_is_closed(port: u16) -> bool {
    let mut stream = connect(port).await;
    read_until_closed(&mut stream, IDLE_CLOSE_WITHIN)
        .await
        .is_some()
}

async fn trickling_client_is_cut_off(port: u16) -> bool {
    let mut stream = connect(port).await;
    let head = format!(
        "POST /indexes/articles/_change-analysis HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {TRICKLE_DECLARED_BYTES}\r\n\r\n{{"
    );
    if stream.write_all(head.as_bytes()).await.is_err() {
        return true;
    }
    let started = Instant::now();
    while started.elapsed() < IDLE_CLOSE_WITHIN {
        tokio::time::sleep(TRICKLE_INTERVAL).await;
        if stream.write_all(b" ").await.is_err() {
            return true;
        }
        let mut probe = [0; 1024];
        match tokio::time::timeout(Duration::from_millis(1), stream.read(&mut probe)).await {
            Ok(Ok(0)) | Ok(Err(_)) => return true,
            Ok(Ok(_)) => {
                return read_until_closed(&mut stream, IDLE_CLOSE_WITHIN)
                    .await
                    .is_some();
            }
            Err(_) => {}
        }
    }
    false
}

fn export_lines() -> String {
    let title = "x".repeat(TITLE_BYTES);
    let mut lines = String::new();
    for serial in 0..EXPORT_DOCUMENTS {
        writeln!(
            lines,
            r#"{{"id":"article-{serial}","title":"{title} {serial}"}}"#
        )
        .expect("a string takes text");
    }
    lines
}

async fn import(port: u16, lines: &str) {
    let reply = send(
        port,
        &Call::new("POST", "/indexes/articles/documents/_import")
            .header("content-type", "application/x-ndjson")
            .raw(lines.to_string()),
    )
    .await;
    assert_eq!(reply.status, 200, "the server imports the documents");
}

fn whole_listing() -> String {
    format!(r#"{{"limit":{EXPORT_DOCUMENTS}}}"#)
}

async fn listing_requested(port: u16, receive_buffer_bytes: u32) -> TcpStream {
    let socket = TcpSocket::new_v4().expect("a socket opens");
    socket
        .set_recv_buffer_size(receive_buffer_bytes)
        .expect("the receive buffer takes a fixed size");
    let mut stream = socket
        .connect(([127, 0, 0, 1], port).into())
        .await
        .expect("the server accepts a connection");
    let body = whole_listing();
    let request = format!(
        "POST /indexes/articles/documents/_list HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .await
        .expect("the request goes out");
    stream
}

async fn stalled_reader_received(port: u16) -> Option<usize> {
    let mut stream = listing_requested(port, STALLED_READER_RECEIVE_BUFFER_BYTES).await;
    tokio::time::sleep(STALLED_READER_PAUSE).await;
    read_until_closed(&mut stream, DRAIN_WITHIN).await
}

async fn slow_reader_received(port: u16) -> Option<usize> {
    let mut stream = listing_requested(port, SLOW_READER_RECEIVE_BUFFER_BYTES).await;
    let mut slice = vec![0; SLOW_READER_READ_BYTES];
    let mut received = 0;
    let started = Instant::now();
    while started.elapsed() < SLOW_READER_PAUSE {
        tokio::time::sleep(SLOW_READER_READ_INTERVAL).await;
        match tokio::time::timeout(DRAIN_WITHIN, stream.read_exact(&mut slice)).await {
            Err(_) => return None,
            Ok(Err(_)) => return Some(received),
            Ok(Ok(_)) => received += SLOW_READER_READ_BYTES,
        }
    }
    read_until_closed(&mut stream, DRAIN_WITHIN)
        .await
        .map(|rest| received + rest)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_connection_that_sends_nothing_is_closed_as_the_typescript_server_closes_it() {
    let servers = Servers::start().await;
    for (name, port) in servers.ports() {
        assert!(
            silent_client_is_closed(port).await,
            "the {name} server keeps a silent connection open past {IDLE_CLOSE_WITHIN:?}"
        );
    }
    servers.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_body_sent_one_byte_a_second_is_cut_off_as_the_typescript_server_cuts_it_off() {
    let servers = Servers::start().await;
    for (name, port) in servers.ports() {
        assert!(
            trickling_client_is_cut_off(port).await,
            "the {name} server waits on a trickled body past {IDLE_CLOSE_WITHIN:?}"
        );
    }
    servers.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_that_stops_reading_a_listing_is_disconnected_as_the_typescript_server_disconnects_it()
 {
    let servers = Servers::start().await;
    let lines = export_lines();
    let mut full_lengths = Vec::new();
    for (_, port) in servers.ports() {
        import(port, &lines).await;
        let full = send(
            port,
            &Call::new("POST", "/indexes/articles/documents/_list")
                .header("content-type", "application/json")
                .raw(whole_listing()),
        )
        .await;
        assert_eq!(full.status, 200, "the server lists every document");
        full_lengths.push(full.body.len());
    }
    let (rust, reference) = tokio::join!(
        stalled_reader_received(servers.rust.port),
        stalled_reader_received(servers.reference.port)
    );
    for ((name, received), full_length) in [("Rust", rust), ("TypeScript", reference)]
        .into_iter()
        .zip(full_lengths)
    {
        let received = received
            .unwrap_or_else(|| panic!("the {name} server kept a stalled reader's connection open"));
        assert!(
            received < full_length,
            "the {name} server sent all {full_length} bytes to a reader that stopped reading for {STALLED_READER_PAUSE:?}, where it should have disconnected; received {received}"
        );
    }
    servers.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_that_reads_a_listing_a_few_kilobytes_at_a_time_is_disconnected() {
    let engine = Narsil::new();
    engine
        .create_index(
            "articles",
            IndexConfig {
                schema: parsed(SCHEMA),
                ..IndexConfig::default()
            },
        )
        .expect("the engine creates the index");
    let rust = RustServer::start(engine, ServerOptions::default()).await;
    import(rust.port, &export_lines()).await;
    let full = send(
        rust.port,
        &Call::new("POST", "/indexes/articles/documents/_list")
            .header("content-type", "application/json")
            .raw(whole_listing()),
    )
    .await;
    assert_eq!(full.status, 200, "the server lists every document");
    let received = slow_reader_received(rust.port)
        .await
        .expect("the server closes a slow reader's connection");
    assert!(
        received < full.body.len(),
        "the server sent all {} bytes to a reader that took {SLOW_READER_READ_BYTES} bytes every {SLOW_READER_READ_INTERVAL:?}, where it should have disconnected",
        full.body.len()
    );
    rust.stop().await;
}
