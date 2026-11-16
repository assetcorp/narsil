mod support;
mod tasks_common;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use narsil::{
    DurabilityConfig, DurabilityMode, FilesystemPersistence, Narsil, NarsilConfig, Value,
};
use narsil_server::{
    PersistenceTaskStore, ServerLimits, ServerOptions, TaskRecord, TaskStatus, TaskStore,
};
use support::{Call, ScratchDirectory, send};
use tasks_common::{
    ARTICLE_SCHEMA, Served, article_lines, at, create_in_engine, json_of, ndjson, ndjson_call,
    number_at, text_at, wait_for_progress, wait_for_task,
};
use tokio::io::{AsyncBufReadExt, BufReader};

const FIRST_LIFE_DIRECTORY: &str = "NARSIL_TASKS_FIRST_LIFE_DIRECTORY";
const FIRST_LIFE_TEST: &str = "first_life_of_a_server_that_crashes_during_an_import";
const INSTANCE: &str = "node-1";
const OTHER_INSTANCE: &str = "node-2";
const IMPORT_DOCUMENTS: usize = 200_000;
const CLOSED_IMPORT_DOCUMENTS: usize = 500_000;
const CHILD_START_DEADLINE: Duration = Duration::from_secs(60);

fn durable_engine(directory: &Path) -> Narsil {
    Narsil::open(NarsilConfig {
        durability: Some(DurabilityConfig {
            directory: Some(directory.join("data")),
            mode: Some(DurabilityMode::Sync),
            ..DurabilityConfig::default()
        }),
        ..NarsilConfig::default()
    })
    .expect("the durable engine opens")
}

fn task_store(directory: &Path) -> Arc<PersistenceTaskStore> {
    let adapter =
        FilesystemPersistence::new(directory.join("tasks")).expect("the task directory opens");
    Arc::new(PersistenceTaskStore::new(Arc::new(adapter)))
}

fn durable_options(store: Arc<PersistenceTaskStore>) -> ServerOptions {
    ServerOptions {
        instance_id: Some(INSTANCE.to_string()),
        task_store: Some(store),
        limits: ServerLimits {
            import_batch_size: Some(1),
            ..ServerLimits::default()
        },
        ..ServerOptions::default()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn first_life_of_a_server_that_crashes_during_an_import() {
    let Some(directory) = std::env::var_os(FIRST_LIFE_DIRECTORY).map(PathBuf::from) else {
        return;
    };
    let engine = durable_engine(&directory);
    create_in_engine(&engine, "articles", ARTICLE_SCHEMA);
    let served = Served::start(engine, durable_options(task_store(&directory))).await;
    println!("READY {}", served.port);
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
}

async fn start_first_life(directory: &Path) -> (tokio::process::Child, u16) {
    let mut child =
        tokio::process::Command::new(std::env::current_exe().expect("the test binary has a path"))
            .args([
                FIRST_LIFE_TEST,
                "--exact",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(FIRST_LIFE_DIRECTORY, directory)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .expect("the first life starts");
    let stdout = child.stdout.take().expect("the first life has a stdout");
    let mut lines = BufReader::new(stdout).lines();
    let port = tokio::time::timeout(CHILD_START_DEADLINE, async {
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some((_, port)) = line.split_once("READY ") {
                return port.trim().parse::<u16>().ok();
            }
        }
        None
    })
    .await
    .ok()
    .flatten()
    .expect("the first life names its port");
    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
    (child, port)
}

fn foreign_record() -> TaskRecord {
    TaskRecord {
        id: "task-of-another-node".to_string(),
        task_type: "rebalance".to_string(),
        index_name: "articles".to_string(),
        backup_name: None,
        status: TaskStatus::Running,
        owner: OTHER_INSTANCE.to_string(),
        created_at: 1.0,
        started_at: Some(1.0),
        completed_at: None,
        cancel_requested_at: None,
        progress: None,
        steps: None,
        result: None,
        build: None,
        error: None,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_restart_fails_the_import_that_the_crashed_server_left_running() {
    let scratch = ScratchDirectory::new("tasks-crash");
    let (mut child, port) = start_first_life(scratch.path()).await;
    let lines = article_lines(IMPORT_DOCUMENTS);
    let reply = send(
        port,
        &ndjson_call(
            "/indexes/articles/documents/_import?async=true",
            &ndjson(&lines),
        ),
    )
    .await;
    assert_eq!(reply.status, 202);
    let id = text_at(&reply.json(), &["id"]).expect("the record has an id");
    let running = wait_for_progress(port, &id, 50.0).await;
    assert_eq!(text_at(&running, &["status"]).as_deref(), Some("running"));
    tokio::time::sleep(Duration::from_millis(400)).await;
    child.kill().await.expect("the first life dies");

    let store = task_store(scratch.path());
    store
        .set(foreign_record(), None)
        .await
        .expect("the store keeps a record of another node");
    let engine = durable_engine(scratch.path());
    let served = Served::start(engine, durable_options(Arc::clone(&store))).await;

    let interrupted = send(served.port, &Call::new("GET", &format!("/tasks/{id}"))).await;
    assert_eq!(interrupted.status, 200, "the record outlives the crash");
    let interrupted = interrupted.json();
    assert_eq!(
        text_at(&interrupted, &["status"]).as_deref(),
        Some("failed")
    );
    assert_eq!(
        at(&interrupted, &["error"]),
        Some(&json_of(
            r#"{"code":"TASK_INTERRUPTED","message":"The server restarted while this task was running"}"#
        ))
    );
    assert!(number_at(&interrupted, &["completedAt"]).is_some());
    let persisted =
        number_at(&interrupted, &["progress", "indexed"]).expect("progress outlives the crash");
    assert!(
        persisted >= 1.0,
        "the first life wrote progress before it died"
    );

    let mut held = 0;
    for (serial, line) in lines.iter().enumerate() {
        let document = served
            .engine
            .get("articles", &format!("article-{serial}"))
            .expect("the read succeeds");
        if let Some(document) = document {
            assert_eq!(
                Value::Object(document),
                json_of(line),
                "document {serial} is whole"
            );
            held += 1;
        }
    }
    assert!(
        held as f64 >= persisted,
        "every write that the progress counted survives; {held} held, {persisted} counted"
    );
    assert!(
        held < IMPORT_DOCUMENTS,
        "the crash stopped the import before the end"
    );

    let foreign = send(
        served.port,
        &Call::new("POST", "/tasks/task-of-another-node/_cancel"),
    )
    .await;
    assert_eq!(foreign.status, 409);
    assert_eq!(
        at(&foreign.json(), &["error"]),
        Some(&json_of(&format!(
            r#"{{"code":"TASK_OWNED_BY_ANOTHER_INSTANCE","message":"Task \"task-of-another-node\" runs on another server instance, which is the only one that can stop it","details":{{"owner":"{OTHER_INSTANCE}"}}}}"#
        )))
    );
    let foreign_record = send(
        served.port,
        &Call::new("GET", "/tasks/task-of-another-node"),
    )
    .await;
    assert_eq!(
        text_at(&foreign_record.json(), &["status"]).as_deref(),
        Some("running"),
        "a restart leaves the tasks of another node alone"
    );
    served.stop().await;
}

fn spool_directories() -> BTreeSet<PathBuf> {
    std::fs::read_dir(std::env::temp_dir())
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with("narsil-spool-"))
                })
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_closing_server_stops_its_import_and_a_restart_reports_it_cancelled() {
    let scratch = ScratchDirectory::new("tasks-close");
    let spools_before = spool_directories();
    let store = task_store(scratch.path());
    let engine = durable_engine(scratch.path());
    create_in_engine(&engine, "articles", ARTICLE_SCHEMA);
    let served = Served::start(engine, durable_options(Arc::clone(&store))).await;

    for body in [
        b"not a snapshot archive".to_vec(),
        b"not an export\n".to_vec(),
        Vec::new(),
    ] {
        for path in ["/indexes/articles/restore", "/indexes/articles/import"] {
            let reply = send(served.port, &Call::new("POST", path).raw(body.clone())).await;
            if reply.status == 202 {
                let id = text_at(&reply.json(), &["id"]).expect("the record has an id");
                assert_eq!(
                    text_at(&wait_for_task(served.port, &id).await, &["status"]).as_deref(),
                    Some("failed")
                );
            }
        }
    }

    let lines = article_lines(CLOSED_IMPORT_DOCUMENTS);
    let reply = send(
        served.port,
        &ndjson_call(
            "/indexes/articles/documents/_import?async=true",
            &ndjson(&lines),
        ),
    )
    .await;
    assert_eq!(reply.status, 202);
    let id = text_at(&reply.json(), &["id"]).expect("the record has an id");
    let running = wait_for_progress(served.port, &id, 1.0).await;
    assert_eq!(text_at(&running, &["status"]).as_deref(), Some("running"));
    served.stop().await;

    let engine = durable_engine(scratch.path());
    let served = Served::start(engine, durable_options(Arc::clone(&store))).await;
    let stopped = send(served.port, &Call::new("GET", &format!("/tasks/{id}")))
        .await
        .json();
    assert_eq!(text_at(&stopped, &["status"]).as_deref(), Some("cancelled"));
    let indexed = number_at(&stopped, &["progress", "indexed"]).expect("progress stays");
    assert_eq!(
        served
            .engine
            .count_documents("articles")
            .ok()
            .map(|count| count as f64),
        Some(indexed),
        "the stopped import wrote exactly what its last progress counts"
    );
    served.stop().await;
    assert_eq!(
        spool_directories().difference(&spools_before).count(),
        0,
        "every spooled body is removed"
    );
}
