mod settings_support;
mod support;

use std::collections::BTreeMap;
use std::time::Duration;

use narsil::{Map, Value};
use settings_support::{
    INDEX, durable_engine, feed_options, field, finished_task, insert_notes, note, note_id,
    reference_spec, same_error, seed, seed_reference,
};
use support::{
    Call, ReferenceServer, Reply, RustServer, ScratchDirectory, TOKEN, decode_json, send,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpSocket, TcpStream};

const FIRST_NOTES: usize = 6_000;
const LATER_NOTES: usize = 500;
const ABANDONED_BYTES: usize = 4_096;
const STALLED_RECEIVE_BUFFER_BYTES: u32 = 64 * 1024;
const LARGE_NOTES: usize = 400;
const LARGE_TITLE_BYTES: usize = 64 * 1024;
const STALL: Duration = Duration::from_secs(14);
const CLOSE_DEADLINE: Duration = Duration::from_secs(30);
const CHUNKED_END: &[u8] = b"\r\n0\r\n\r\n";
const PEEKED_BYTES: usize = 4 * 1024 * 1024;
const RECEIVE_BUFFER_STEADY: Duration = Duration::from_secs(1);
const RECEIVE_BUFFER_POLL: Duration = Duration::from_millis(50);
const GRAPH_BUILD_DEADLINE: Duration = Duration::from_secs(60);
const GRAPH_BUILD_POLL: Duration = Duration::from_millis(100);

fn same_fields(left: &Map, right: &Map) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .all(|(key, value)| right.get(key) == Some(value))
}

fn exported_documents(reply: &Reply) -> BTreeMap<String, Map> {
    assert_eq!(reply.status, 200);
    assert_eq!(reply.header("content-type"), Some("application/x-ndjson"));
    let text = String::from_utf8(reply.body.to_vec()).expect("an export is UTF-8");
    let mut lines = text.lines();
    let header = decode_json(lines.next().expect("an export starts with a header"))
        .expect("the header is JSON");
    assert_eq!(
        field(&header, "format"),
        Some(&Value::String("narsil-export".to_string()))
    );
    assert_eq!(field(&header, "version"), Some(&Value::Number(1.0)));
    let mut documents = BTreeMap::new();
    for line in lines {
        let Ok(Value::Object(mut document)) = decode_json(line) else {
            panic!("each document line is a JSON object: {line}");
        };
        let Some(Value::String(id)) = document.remove("id") else {
            panic!("each document line carries its id");
        };
        assert!(
            documents.insert(id.clone(), document).is_none(),
            "{id} appears once"
        );
    }
    documents
}

fn assert_holds_notes(documents: &BTreeMap<String, Map>, count: usize) {
    assert_eq!(documents.len(), count, "the export lists every note once");
    for at in 0..count {
        let held = documents
            .get(&note_id(at))
            .unwrap_or_else(|| panic!("the export holds {}", note_id(at)));
        assert!(
            same_fields(held, &note(at)),
            "{} keeps its fields",
            note_id(at)
        );
    }
}

async fn abandon(port: u16, path: &str) {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("the server accepts a connection");
    let request =
        format!("GET {path} HTTP/1.1\r\nhost: 127.0.0.1\r\nauthorization: Bearer {TOKEN}\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .expect("the request is sent");
    let mut start = vec![0u8; ABANDONED_BYTES];
    let read = stream.read(&mut start).await.expect("the answer starts");
    assert!(read > 0);
    drop(stream);
}

fn builds_a_graph(field_status: &Value) -> bool {
    matches!(field_status, Value::Object(status) if status.get("building") != Some(&Value::Bool(false)))
}

async fn wait_until_no_graph_builds(port: u16) {
    let status_path = format!("/indexes/{INDEX}/vector-maintenance");
    let status = Call::new("GET", &status_path).authorized();
    let deadline = tokio::time::Instant::now() + GRAPH_BUILD_DEADLINE;
    loop {
        let reply = send(port, &status).await;
        assert_eq!(reply.status, 200);
        let Some(Value::Array(fields)) = field(&reply.json(), "fields").cloned() else {
            panic!("the vector maintenance status lists its fields");
        };
        if !fields.iter().any(builds_a_graph) {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the vector graph finishes building within {GRAPH_BUILD_DEADLINE:?}"
        );
        tokio::time::sleep(GRAPH_BUILD_POLL).await;
    }
}

async fn imported_count(reference: &ReferenceServer, index: &str) -> Value {
    let count = send(
        reference.port,
        &Call::new("GET", &format!("/indexes/{index}/count")).authorized(),
    )
    .await;
    field(&count.json(), "count")
        .cloned()
        .unwrap_or(Value::Null)
}

#[tokio::test(flavor = "multi_thread")]
async fn exports_and_snapshots_stream_every_document_across_restarts() {
    let scratch = ScratchDirectory::new("settings-streams");
    let directory = scratch.path().join("data");
    let engine = durable_engine(&directory);
    seed(&engine, FIRST_NOTES);
    let rust = RustServer::start(engine, feed_options(false, false)).await;
    let export_path = format!("/indexes/{INDEX}/export");
    let snapshot_path = format!("/indexes/{INDEX}/snapshot");

    for path in [&export_path, &snapshot_path] {
        for _ in 0..3 {
            abandon(rust.port, path).await;
        }
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    let export = send(rust.port, &Call::new("GET", &export_path).authorized()).await;
    assert_eq!(export.header("content-length"), None, "an export streams");
    assert_holds_notes(&exported_documents(&export), FIRST_NOTES);
    rust.stop().await;

    let engine = durable_engine(&directory);
    insert_notes(&engine, FIRST_NOTES..FIRST_NOTES + LATER_NOTES);
    let rust = RustServer::start(engine, feed_options(false, false)).await;
    let export = send(rust.port, &Call::new("GET", &export_path).authorized()).await;
    assert_holds_notes(&exported_documents(&export), FIRST_NOTES + LATER_NOTES);
    wait_until_no_graph_builds(rust.port).await;
    let snapshot = send(rust.port, &Call::new("GET", &snapshot_path).authorized()).await;
    assert_eq!(snapshot.status, 200);
    assert_eq!(snapshot.header("content-type"), Some("application/x-tar"));
    let with_history = send(
        rust.port,
        &Call::new("GET", &format!("{snapshot_path}?queryHistory=true")).authorized(),
    )
    .await;
    assert_eq!(with_history.status, 200);
    rust.stop().await;

    let same_directory =
        ReferenceServer::start(reference_spec(Some(&directory), false, false)).await;
    for (path, mine) in [(&export_path, &export), (&snapshot_path, &snapshot)] {
        let theirs = send(same_directory.port, &Call::new("GET", path).authorized()).await;
        assert_eq!(theirs.status, 200);
        assert_eq!(theirs.header("content-type"), mine.header("content-type"));
        assert!(
            theirs.body == mine.body,
            "{path} holds the bytes that the TypeScript server serves from the same directory: Rust {} bytes, TypeScript {} bytes",
            mine.body.len(),
            theirs.body.len()
        );
    }
    same_directory.stop().await;

    let reference = ReferenceServer::start(reference_spec(None, false, false)).await;
    let imported = send(
        reference.port,
        &Call::new("POST", "/indexes/imported/import")
            .authorized()
            .header("content-type", "application/x-ndjson")
            .raw(export.body.clone()),
    )
    .await;
    let record = finished_task(reference.port, &imported).await;
    assert_eq!(
        field(&record, "status"),
        Some(&Value::String("succeeded".to_string())),
        "{record:?}"
    );
    assert_eq!(
        imported_count(&reference, "imported").await,
        Value::Number((FIRST_NOTES + LATER_NOTES) as f64),
        "the TypeScript server imports every document of the Rust export"
    );
    for archive in [&snapshot, &with_history] {
        let restored = send(
            reference.port,
            &Call::new("POST", "/indexes/copy/restore")
                .authorized()
                .header("content-type", "application/x-tar")
                .raw(archive.body.clone()),
        )
        .await;
        let record = finished_task(reference.port, &restored).await;
        assert_eq!(
            field(&record, "status"),
            Some(&Value::String("succeeded".to_string())),
            "{record:?}"
        );
        assert_eq!(
            imported_count(&reference, "copy").await,
            Value::Number((FIRST_NOTES + LATER_NOTES) as f64),
            "the TypeScript server restores every document of the Rust snapshot"
        );
        let held = send(
            reference.port,
            &Call::new(
                "GET",
                &format!("/indexes/copy/documents/{}", note_id(FIRST_NOTES)),
            )
            .authorized(),
        )
        .await;
        assert_eq!(held.status, 200);
    }
    reference.stop().await;
}

async fn connect_with_fixed_receive_buffer(port: u16) -> TcpStream {
    let socket = TcpSocket::new_v4().expect("the client opens a socket");
    socket
        .set_recv_buffer_size(STALLED_RECEIVE_BUFFER_BYTES)
        .expect("the client fixes its receive buffer");
    socket
        .connect(([127, 0, 0, 1], port).into())
        .await
        .expect("the server accepts a connection")
}

async fn wait_until_the_server_stops_sending(stream: &TcpStream) {
    let mut queued = vec![0u8; PEEKED_BYTES];
    let mut last_queued = 0;
    let mut steady_since = tokio::time::Instant::now();
    loop {
        let now_queued = stream
            .peek(&mut queued)
            .await
            .expect("the client reads what waits in its receive buffer");
        if now_queued != last_queued {
            last_queued = now_queued;
            steady_since = tokio::time::Instant::now();
        } else if steady_since.elapsed() >= RECEIVE_BUFFER_STEADY {
            return;
        }
        tokio::time::sleep(RECEIVE_BUFFER_POLL).await;
    }
}

async fn read_until_closed(stream: &mut TcpStream) -> Vec<u8> {
    let mut received = Vec::new();
    tokio::time::timeout(CLOSE_DEADLINE, stream.read_to_end(&mut received))
        .await
        .expect("the server closes a stalled download")
        .ok();
    received
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stalled_download_is_cut_off_and_never_looks_complete() {
    let engine = narsil::Narsil::new();
    seed(&engine, 0);
    let filler = "w".repeat(LARGE_TITLE_BYTES);
    for at in 0..LARGE_NOTES {
        let mut large = note(at);
        large.insert("title", Value::String(format!("{filler} {at}")));
        engine
            .insert(INDEX, large, Some(&note_id(at)))
            .expect("the large note is inserted");
    }
    let rust = RustServer::start(engine, feed_options(false, false)).await;
    let mut stalled = Vec::new();
    for path in [
        format!("/indexes/{INDEX}/export"),
        format!("/indexes/{INDEX}/snapshot"),
    ] {
        let mut stream = connect_with_fixed_receive_buffer(rust.port).await;
        let request = format!(
            "GET {path} HTTP/1.1\r\nhost: 127.0.0.1\r\nauthorization: Bearer {TOKEN}\r\n\r\n"
        );
        stream
            .write_all(request.as_bytes())
            .await
            .expect("the request is sent");
        let mut start = vec![0u8; ABANDONED_BYTES];
        assert!(stream.read(&mut start).await.expect("the answer starts") > 0);
        stalled.push((path, stream));
    }
    for (_, stream) in &stalled {
        wait_until_the_server_stops_sending(stream).await;
    }
    tokio::time::sleep(STALL).await;
    let synonyms = send(
        rust.port,
        &Call::new("GET", &format!("/indexes/{INDEX}/synonyms")).authorized(),
    )
    .await;
    assert_eq!(synonyms.status, 200, "a stalled download holds no engine");

    let whole_export = send(
        rust.port,
        &Call::new("GET", &format!("/indexes/{INDEX}/export")).authorized(),
    )
    .await;
    let exported = exported_documents(&whole_export);
    assert_eq!(exported.len(), LARGE_NOTES);
    for (path, mut stream) in stalled {
        let rest = read_until_closed(&mut stream).await;
        assert!(
            rest.len() + ABANDONED_BYTES < whole_export.body.len(),
            "{path} stops early: {} bytes after the stall",
            rest.len()
        );
        assert!(
            !rest.ends_with(CHUNKED_END),
            "{path} never ends the way a complete answer ends"
        );
    }
    rust.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn export_and_snapshot_refusals_match_the_typescript_server() {
    let engine = narsil::Narsil::new();
    seed(&engine, 3);
    let rust = RustServer::start(engine, feed_options(false, false)).await;
    let reference = ReferenceServer::start(reference_spec(None, false, false)).await;
    seed_reference(&reference, 3).await;
    for path in [
        "/indexes/ghost/export",
        "/indexes/ghost/snapshot",
        "/indexes/ghost/snapshot?queryHistory=yes",
        "/indexes/notes/snapshot?queryHistory=yes",
        "/indexes/notes/snapshot?queryHistory=TRUE",
        "/indexes/notes/snapshot?queryHistory=",
        "/indexes/notes/snapshot?queryHistory",
        "/indexes/notes/snapshot?queryHistory=1&queryHistory=true",
        "/indexes/notes/snapshot?queryHistory=%E2%9C%93",
    ] {
        same_error(
            rust.port,
            reference.port,
            &Call::new("GET", path).authorized(),
        )
        .await;
    }
    for path in ["/indexes/notes/export", "/indexes/notes/snapshot"] {
        same_error(rust.port, reference.port, &Call::new("GET", path)).await;
        let mine = send(rust.port, &Call::new("GET", path).authorized()).await;
        let theirs = send(reference.port, &Call::new("GET", path).authorized()).await;
        assert_eq!(
            (mine.status, mine.header("content-type")),
            (theirs.status, theirs.header("content-type"))
        );
    }
    reference.stop().await;
    rust.stop().await;
}
