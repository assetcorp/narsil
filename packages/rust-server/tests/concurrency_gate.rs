mod support;

use std::time::Duration;

use narsil::{Narsil, Value};
use narsil_server::{ServerLimits, ServerOptions};
use support::{Call, ReferenceServer, RustServer, TOKEN, object, send, token_hook};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const INDEX: &str = "pages";
const DOCUMENTS: usize = 512;
const DOCUMENTS_PER_BATCH: usize = 32;
const TEXT_BYTES: usize = 64 * 1024;
const SETTLE: Duration = Duration::from_millis(300);

fn create_call() -> Call<'static> {
    Call::new("POST", "/indexes")
        .authorized()
        .json(&object(vec![
            ("name", Value::String(INDEX.to_string())),
            (
                "config",
                object(vec![(
                    "schema",
                    object(vec![("body", Value::String("string".to_string()))]),
                )]),
            ),
        ]))
}

async fn seed(port: u16) {
    assert_eq!(send(port, &create_call()).await.status, 201);
    let text = "w".repeat(TEXT_BYTES);
    let path = format!("/indexes/{INDEX}/documents/_batch");
    for start in (0..DOCUMENTS).step_by(DOCUMENTS_PER_BATCH) {
        let documents = (start..start + DOCUMENTS_PER_BATCH)
            .map(|at| {
                object(vec![
                    ("id", Value::String(format!("page-{at:04}"))),
                    ("body", Value::String(text.clone())),
                ])
            })
            .collect();
        let call = Call::new("POST", &path)
            .authorized()
            .json(&object(vec![("documents", Value::Array(documents))]));
        assert_eq!(send(port, &call).await.status, 200);
    }
}

async fn stalled_listing(port: u16) -> TcpStream {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("the server accepts a connection");
    let body = format!("{{\"limit\":{DOCUMENTS}}}");
    let request = format!(
        "POST /indexes/{INDEX}/documents/_list HTTP/1.1\r\nhost: 127.0.0.1\r\nauthorization: Bearer {TOKEN}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .await
        .expect("the request is sent");
    let mut start = [0u8; 256];
    let read = stream.read(&mut start).await.expect("the answer starts");
    assert!(
        String::from_utf8_lossy(&start[..read]).starts_with("HTTP/1.1 200"),
        "the listing starts with a 200"
    );
    tokio::time::sleep(SETTLE).await;
    stream
}

async fn statuses_around_a_stalled_download(port: u16) -> (u16, u16) {
    let listing = Call::new("GET", "/indexes").authorized();
    let stalled = stalled_listing(port).await;
    let during = send(port, &listing).await.status;
    drop(stalled);
    tokio::time::sleep(SETTLE).await;
    let after = send(port, &listing).await.status;
    (during, after)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_download_that_the_client_stops_reading_keeps_its_request_slot_on_both_servers() {
    let rust = RustServer::start(
        Narsil::new(),
        token_hook(ServerOptions {
            limits: ServerLimits {
                max_concurrent_requests: Some(1),
                ..ServerLimits::default()
            },
            ..ServerOptions::default()
        }),
    )
    .await;
    let reference = ReferenceServer::start(object(vec![
        ("token", Value::String(TOKEN.to_string())),
        (
            "limits",
            object(vec![("maxConcurrentRequests", Value::Number(1.0))]),
        ),
    ]))
    .await;
    seed(rust.port).await;
    seed(reference.port).await;

    let theirs = statuses_around_a_stalled_download(reference.port).await;
    let mine = statuses_around_a_stalled_download(rust.port).await;
    assert_eq!(
        theirs,
        (429, 200),
        "the TypeScript server holds the slot until the download ends"
    );
    assert_eq!(mine, theirs, "the Rust server holds the slot the same way");

    reference.stop().await;
    rust.stop().await;
}
