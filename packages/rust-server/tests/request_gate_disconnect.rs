mod support;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use narsil::{AdapterError, EmbeddingAdapter, EmbeddingPurpose, Narsil};
use narsil_server::{ServerLimits, ServerOptions};
use support::{Call, RustServer, parsed, send};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

const EMBEDDING_DELAY: Duration = Duration::from_millis(1_500);
const RESET_AFTER: Duration = Duration::from_millis(200);
const DISCONNECTING_SEARCHES: usize = 3;
const SETTLE_DEADLINE: Duration = Duration::from_secs(20);
const POLL_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Default)]
struct SlowEmbedding {
    active: AtomicUsize,
    most_active: AtomicUsize,
}

impl EmbeddingAdapter for SlowEmbedding {
    fn dimensions(&self) -> usize {
        2
    }

    fn embed(&self, _input: &str, _purpose: EmbeddingPurpose) -> Result<Vec<f32>, AdapterError> {
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.most_active.fetch_max(active, Ordering::SeqCst);
        std::thread::sleep(EMBEDDING_DELAY);
        self.active.fetch_sub(1, Ordering::SeqCst);
        Ok(vec![1.0, 0.0])
    }
}

async fn search_then_reset(port: u16) {
    let body = r#"{"vector":{"field":"v","text":"delayed request"}}"#;
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("the server accepts a connection");
    let request = format!(
        "POST /indexes/articles/search HTTP/1.1\r\nhost: 127.0.0.1:{port}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .await
        .expect("the request is written");
    tokio::time::sleep(RESET_AFTER).await;
    stream.set_zero_linger().expect("the socket resets on drop");
    drop(stream);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_client_that_disconnects_keeps_its_request_slot_until_the_engine_finishes() {
    let embedding = Arc::new(SlowEmbedding::default());
    let engine = Narsil::new();
    engine
        .register_embedding_adapter("slow", Arc::clone(&embedding) as Arc<dyn EmbeddingAdapter>)
        .expect("the adapter registers");
    let rust = RustServer::start(
        engine,
        ServerOptions {
            limits: ServerLimits {
                max_concurrent_requests: Some(1),
                ..ServerLimits::default()
            },
            ..ServerOptions::default()
        },
    )
    .await;
    let created = send(
        rust.port,
        &Call::new("POST", "/indexes").json(&parsed(
            r#"{"name":"articles","config":{"schema":{"title":"string","v":"vector[2]"},"embedding":{"adapter":"slow","fields":{"v":"title"}}}}"#,
        )),
    )
    .await;
    assert_eq!(created.status, 201, "the server creates the index");

    let mut while_running = Vec::new();
    for _ in 0..DISCONNECTING_SEARCHES {
        search_then_reset(rust.port).await;
        while_running.push(send(rust.port, &Call::new("GET", "/indexes")).await.status);
    }
    assert_eq!(while_running, vec![429; DISCONNECTING_SEARCHES]);

    let deadline = tokio::time::Instant::now() + SETTLE_DEADLINE;
    while embedding.active.load(Ordering::SeqCst) > 0 {
        assert!(tokio::time::Instant::now() < deadline, "the embedding ends");
        tokio::time::sleep(POLL_INTERVAL).await;
    }
    let mut after = send(rust.port, &Call::new("GET", "/indexes")).await.status;
    while after == 429 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(POLL_INTERVAL).await;
        after = send(rust.port, &Call::new("GET", "/indexes")).await.status;
    }
    assert_eq!(after, 200, "the slot frees once the engine finishes");
    assert_eq!(embedding.most_active.load(Ordering::SeqCst), 1);
    tokio::time::timeout(SETTLE_DEADLINE, rust.stop())
        .await
        .expect("the server shuts down");
}
