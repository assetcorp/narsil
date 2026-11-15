mod settings_support;
mod support;

use std::time::Duration;

use narsil::Value;
use narsil_server::ServerOptions;
use settings_support::{
    INDEX, durable_engine, feed_options, field, finished_task, insert_notes, reference_spec, seed,
};
use support::{Call, ReferenceServer, Reply, RustServer, ScratchDirectory, send, token_hook};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const FIRST_NOTES: usize = 2_000;
const LATER_NOTES: usize = 300;
const TAG: &str = "{tag}";
const COMPARED_HEADERS: [&str; 7] = [
    "content-type",
    "etag",
    "accept-ranges",
    "cache-control",
    "content-range",
    "content-length",
    "retry-after",
];
const RANGE_CASES: [(Option<&str>, Option<&str>); 30] = [
    (None, None),
    (Some("bytes=0-9"), None),
    (Some("bytes=10-"), None),
    (Some("bytes=-100"), None),
    (Some("bytes=-0"), None),
    (Some("bytes=0-0"), None),
    (Some("bytes=5-2"), None),
    (Some("bytes=99999999-"), None),
    (Some("bytes=99999999-100000000"), None),
    (Some("bytes=0-99999999999999999999"), None),
    (Some("bytes=-99999999999999999999"), None),
    (Some("bytes=000123-000200"), None),
    (Some("bytes=123456789012345678901-"), None),
    (Some("bytes=0-9,20-29"), None),
    (Some("BYTES=0-9"), None),
    (Some("bytes=0-9x"), None),
    (Some("bytes=a-b"), None),
    (Some("bytes=-"), None),
    (Some("bytes=--5"), None),
    (Some("items=0-9"), None),
    (Some(""), None),
    (Some("bytes=0-9"), Some("\"{tag}\"")),
    (Some("bytes=-0"), Some("\"{tag}\"")),
    (Some("bytes=0-9"), Some("{tag}")),
    (Some("bytes=0-9"), Some("W/\"{tag}\"")),
    (Some("bytes=0-9"), Some("\"0000\"")),
    (Some("bytes=-0"), Some("\"0000\"")),
    (Some("bytes=0-9"), Some("Wed, 21 Oct 2015 07:28:00 GMT")),
    (Some("bytes=0-9"), Some("")),
    (None, Some("\"{tag}\"")),
];

fn snapshot_path() -> String {
    format!("/indexes/{INDEX}/sync/snapshot")
}

fn ranged<'a>(path: &'a str, case: (Option<&str>, Option<&str>), tag: &str) -> Call<'a> {
    let mut call = Call::new("GET", path).authorized();
    if let Some(range) = case.0 {
        call = call.header("range", range.replace(TAG, tag));
    }
    if let Some(if_range) = case.1 {
        call = call.header("if-range", if_range.replace(TAG, tag));
    }
    call
}

type ComparedReply = (u16, Vec<(&'static str, Option<String>)>, Vec<u8>);

fn compared(reply: &Reply) -> ComparedReply {
    let headers = COMPARED_HEADERS
        .iter()
        .map(|name| (*name, reply.header(name).map(str::to_string)))
        .collect();
    (reply.status, headers, reply.body.to_vec())
}

async fn answers(port: u16, tag: &str) -> Vec<(u16, Vec<(&'static str, Option<String>)>, Vec<u8>)> {
    let path = snapshot_path();
    let mut replies = Vec::new();
    for case in RANGE_CASES {
        replies.push(compared(&send(port, &ranged(&path, case, tag)).await));
    }
    replies
}

fn tag_of(reply: &Reply) -> String {
    reply
        .header("etag")
        .map(|tag| tag.trim_matches('"').to_string())
        .expect("the snapshot carries an entity tag")
}

async fn abandon_download(port: u16) {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("the server accepts a connection");
    let request = format!(
        "GET {} HTTP/1.1\r\nhost: 127.0.0.1\r\nauthorization: Bearer {}\r\n\r\n",
        snapshot_path(),
        support::TOKEN
    );
    stream
        .write_all(request.as_bytes())
        .await
        .expect("the request is sent");
    let mut start = [0u8; 512];
    let read = stream.read(&mut start).await.expect("the answer starts");
    assert!(read > 0);
    drop(stream);
    tokio::time::sleep(Duration::from_millis(100)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_device_gets_the_same_snapshot_bytes_and_ranges_from_both_servers() {
    let scratch = ScratchDirectory::new("settings-sync-snapshot");
    let directory = scratch.path().join("data");
    let engine = durable_engine(&directory);
    seed(&engine, FIRST_NOTES);
    engine
        .create_index("drafts", settings_support::index_config())
        .expect("the second index is created");
    let rust = RustServer::start(engine, feed_options(true, false)).await;
    let enable = Call::new("PUT", "/indexes/notes/sync")
        .authorized()
        .header("content-type", "application/json")
        .raw(r#"{"enabled":true}"#);
    assert_eq!(send(rust.port, &enable).await.status, 200);

    let path = snapshot_path();
    let whole = send(rust.port, &Call::new("GET", &path).authorized()).await;
    assert_eq!(whole.status, 200);
    let tag = tag_of(&whole);
    let archive = whole.body.to_vec();
    assert!(archive.len() > 64 * 1024, "the archive spans many chunks");
    assert_eq!(
        whole.header("content-length"),
        Some(archive.len().to_string().as_str())
    );
    let first_ten = send(rust.port, &ranged(&path, (Some("bytes=0-9"), None), &tag)).await;
    assert_eq!(first_ten.status, 206);
    assert_eq!(first_ten.body.as_ref(), &archive[..10]);
    let suffix = send(rust.port, &ranged(&path, (Some("bytes=-100"), None), &tag)).await;
    assert_eq!(suffix.body.as_ref(), &archive[archive.len() - 100..]);
    assert_eq!(
        suffix.header("content-range"),
        Some(
            format!(
                "bytes {}-{}/{}",
                archive.len() - 100,
                archive.len() - 1,
                archive.len()
            )
            .as_str()
        )
    );

    abandon_download(rust.port).await;
    let mine_before = answers(rust.port, &tag).await;
    rust.stop().await;

    let engine = durable_engine(&directory);
    insert_notes(&engine, FIRST_NOTES..FIRST_NOTES + LATER_NOTES);
    engine
        .checkpoint(INDEX)
        .expect("the later notes reach a checkpoint");
    let rust = RustServer::start(engine, feed_options(true, false)).await;
    let mine_after = answers(rust.port, &tag).await;
    assert_eq!(
        mine_after, mine_before,
        "later writes and a restart keep the published snapshot"
    );
    let mut errors = Vec::new();
    for call in [
        Call::new("GET", "/indexes/ghost/sync/snapshot").authorized(),
        Call::new("GET", "/indexes/drafts/sync/snapshot").authorized(),
        Call::new("GET", &path),
    ] {
        errors.push(compared(&send(rust.port, &call).await));
    }
    rust.stop().await;

    let reference = ReferenceServer::start(reference_spec(Some(&directory), true, false)).await;
    let theirs = answers(reference.port, &tag).await;
    for ((case, mine), theirs) in RANGE_CASES.iter().zip(&mine_after).zip(&theirs) {
        assert_eq!(mine, theirs, "both servers answer {case:?} alike");
    }
    for (call, mine) in [
        Call::new("GET", "/indexes/ghost/sync/snapshot").authorized(),
        Call::new("GET", "/indexes/drafts/sync/snapshot").authorized(),
        Call::new("GET", &path),
    ]
    .iter()
    .zip(&errors)
    {
        let theirs = send(reference.port, call).await;
        assert_eq!(
            (mine.0, &mine.2),
            (theirs.status, &theirs.body.to_vec()),
            "{}",
            call.path
        );
    }

    let restore = Call::new("POST", "/indexes/copy/restore")
        .authorized()
        .header("content-type", "application/x-tar")
        .raw(archive);
    let accepted = send(reference.port, &restore).await;
    let record = finished_task(reference.port, &accepted).await;
    assert_eq!(
        field(&record, "status"),
        Some(&Value::String("succeeded".to_string()))
    );
    let count = send(
        reference.port,
        &Call::new("GET", "/indexes/copy/count").authorized(),
    )
    .await;
    assert_eq!(
        field(&count.json(), "count"),
        Some(&Value::Number(FIRST_NOTES as f64)),
        "the archive holds the notes from before the first download"
    );
    reference.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_server_without_device_sync_hides_the_snapshot_route_as_typescript_does() {
    let engine = narsil::Narsil::new();
    seed(&engine, 3);
    let rust = RustServer::start(engine, token_hook(ServerOptions::default())).await;
    let reference = ReferenceServer::start(reference_spec(None, false, false)).await;
    settings_support::seed_reference(&reference, 3).await;
    for call in [
        Call::new("GET", "/indexes/notes/sync/snapshot").authorized(),
        Call::new("GET", "/indexes/ghost/sync/snapshot").authorized(),
        Call::new("GET", "/indexes/notes/sync/snapshot")
            .authorized()
            .header("range", "bytes=0-9"),
        Call::new("GET", "/indexes/notes/sync/snapshot"),
    ] {
        settings_support::same_error(rust.port, reference.port, &call).await;
    }
    reference.stop().await;
    rust.stop().await;

    let engine = narsil::Narsil::new();
    seed(&engine, 3);
    let rust = RustServer::start(engine, feed_options(true, false)).await;
    let reference = ReferenceServer::start(reference_spec(None, true, false)).await;
    settings_support::seed_reference(&reference, 3).await;
    for call in [
        Call::new("GET", "/indexes/notes/sync/snapshot").authorized(),
        Call::new("GET", "/indexes/ghost/sync/snapshot").authorized(),
    ] {
        settings_support::same_error(rust.port, reference.port, &call).await;
    }
    reference.stop().await;
    rust.stop().await;
}
