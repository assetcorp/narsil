mod support;
mod tasks_common;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use narsil::Narsil;
use narsil_server::{
    InMemoryTaskStore, ServerLimits, ServerOptions, StoreFuture, TaskRecord, TaskStore,
};
use support::send;
use tasks_common::{
    ARTICLE_SCHEMA, Served, create_in_engine, ndjson_call, stored_ids, text_at, wait_for_task,
};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

const SLOW_FIRST_WRITE: Duration = Duration::from_secs(2);
const RESET_AFTER: Duration = Duration::from_millis(300);
const RECOVERY_DEADLINE: Duration = Duration::from_secs(20);
const RETRY_INTERVAL: Duration = Duration::from_millis(100);
const IMPORT_PATH: &str = "/indexes/articles/documents/_import?async=true";

struct SlowFirstWrite {
    pending: AtomicBool,
    records: InMemoryTaskStore,
}

impl TaskStore for SlowFirstWrite {
    fn set(&self, record: TaskRecord, ttl: Option<Duration>) -> StoreFuture<'_, ()> {
        let slow = self.pending.swap(false, Ordering::AcqRel);
        Box::pin(async move {
            if slow {
                tokio::time::sleep(SLOW_FIRST_WRITE).await;
            }
            self.records.set(record, ttl).await
        })
    }

    fn get(&self, id: &str) -> StoreFuture<'_, Option<TaskRecord>> {
        self.records.get(id)
    }

    fn list(&self) -> StoreFuture<'_, Vec<TaskRecord>> {
        self.records.list()
    }

    fn delete(&self, id: &str) -> StoreFuture<'_, ()> {
        self.records.delete(id)
    }
}

fn import_line(id: &str) -> String {
    format!(r#"{{"id":"{id}","title":"{id}","views":1}}"#)
}

async fn start_then_reset(port: u16, body: &str) {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("the server accepts a connection");
    let request = format!(
        "POST {IMPORT_PATH} HTTP/1.1\r\nhost: 127.0.0.1:{port}\r\ncontent-type: application/x-ndjson\r\ncontent-length: {}\r\n\r\n{body}",
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_client_that_resets_while_its_task_record_is_written_strands_no_task() {
    let store = Arc::new(SlowFirstWrite {
        pending: AtomicBool::new(true),
        records: InMemoryTaskStore::default(),
    });
    let engine = Narsil::open(narsil::NarsilConfig::default()).expect("the engine opens");
    create_in_engine(&engine, "articles", ARTICLE_SCHEMA);
    let served = Served::start(
        engine,
        ServerOptions {
            task_store: Some(store),
            limits: ServerLimits {
                max_concurrent_tasks: Some(1),
                ..ServerLimits::default()
            },
            ..ServerOptions::default()
        },
    )
    .await;
    start_then_reset(served.port, &import_line("stranded")).await;
    let deadline = tokio::time::Instant::now() + RECOVERY_DEADLINE;
    let later_body = import_line("later");
    let later = loop {
        let reply = send(served.port, &ndjson_call(IMPORT_PATH, &later_body)).await;
        if reply.status == 202 {
            break text_at(&reply.json(), &["id"]).expect("the record has an id");
        }
        assert_eq!(
            reply.status,
            429,
            "{}",
            String::from_utf8_lossy(&reply.body)
        );
        assert!(
            tokio::time::Instant::now() < deadline,
            "the task of the reset client finishes and frees its slot"
        );
        tokio::time::sleep(RETRY_INTERVAL).await;
    };
    let record = wait_for_task(served.port, &later).await;
    assert_eq!(text_at(&record, &["status"]).as_deref(), Some("succeeded"));
    let candidates = vec!["stranded".to_string(), "later".to_string()];
    assert_eq!(
        stored_ids(&served.engine, "articles", &candidates),
        candidates
    );
    tokio::time::timeout(RECOVERY_DEADLINE, served.stop())
        .await
        .expect("the server shuts down with no stranded task");
}
