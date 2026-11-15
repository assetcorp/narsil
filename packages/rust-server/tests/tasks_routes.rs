mod support;
mod tasks_common;

use narsil::{Narsil, Value};
use narsil_server::{ServerLimits, ServerOptions};
use support::{Call, ReferenceServer, object, same_status_and_code, send};
use tasks_common::{
    ARTICLE_SCHEMA, Served, article_lines, at, create_in_engine, create_over_http, ndjson,
    ndjson_call, number_at, stored_ids, text_at, wait_for_progress, wait_for_task,
};

const SLOW_IMPORT_DOCUMENTS: usize = 200_000;

fn page_shape(page: &Value) -> (Option<f64>, Option<f64>, Option<f64>, Option<Value>) {
    (
        number_at(page, &["total"]),
        number_at(page, &["from"]),
        number_at(page, &["limit"]),
        at(page, &["next"]).cloned(),
    )
}

fn tasks_of(page: &Value) -> Vec<Value> {
    match at(page, &["tasks"]) {
        Some(Value::Array(tasks)) => tasks.clone(),
        _ => Vec::new(),
    }
}

fn slow_import_options(max_concurrent_tasks: u64) -> ServerOptions {
    ServerOptions {
        limits: ServerLimits {
            import_batch_size: Some(1),
            max_concurrent_tasks: Some(max_concurrent_tasks),
            max_task_page_size: Some(5),
            ..ServerLimits::default()
        },
        ..ServerOptions::default()
    }
}

fn slow_import_spec(max_concurrent_tasks: f64) -> Value {
    object(vec![(
        "limits",
        object(vec![
            ("importBatchSize", Value::Number(1.0)),
            ("maxConcurrentTasks", Value::Number(max_concurrent_tasks)),
            ("maxTaskPageSize", Value::Number(5.0)),
        ]),
    )])
}

async fn start_slow_import(port: u16, body: &str) -> String {
    let reply = send(
        port,
        &ndjson_call("/indexes/articles/documents/_import?async=true", body),
    )
    .await;
    assert_eq!(
        reply.status,
        202,
        "{}",
        String::from_utf8_lossy(&reply.body)
    );
    text_at(&reply.json(), &["id"]).expect("the record has an id")
}

#[tokio::test(flavor = "multi_thread")]
async fn the_task_list_refuses_each_bad_filter_as_the_typescript_server_does() {
    let rust = Served::start(Narsil::new(), slow_import_options(4)).await;
    let reference = ReferenceServer::start(slow_import_spec(4.0)).await;

    for path in [
        "/tasks?type=bogus",
        "/tasks?type=",
        "/tasks?type=import,%20bogus,rebalance",
        "/tasks?status=done",
        "/tasks?status=running,",
        "/tasks?from=-1",
        "/tasks?from=1.5",
        "/tasks?from=abc",
        "/tasks?limit=0",
        "/tasks?limit=abc",
        "/tasks?limit=6",
        "/tasks?limit=1e1",
        "/tasks?limit=Infinity",
        "/tasks/no-such-task",
    ] {
        let (mine, theirs) =
            same_status_and_code(rust.port, reference.port, &Call::new("GET", path)).await;
        assert!(mine.status >= 400, "{path} is refused");
        assert_eq!(mine.json(), theirs.json(), "{path} carries the same error");
    }
    for path in [
        "/tasks?type=import,%20rebuildAnalysis&limit=5",
        "/tasks?status=failed&status=bogus&limit=2",
        "/tasks?from=0x10&limit=%202%20",
        "/tasks?from=&limit=0b11",
        "/tasks?from=1e2&limit=5.0&indexName=",
    ] {
        let (mine, theirs) =
            same_status_and_code(rust.port, reference.port, &Call::new("GET", path)).await;
        assert_eq!(mine.status, 200, "{path} is accepted");
        assert_eq!(mine.json(), theirs.json(), "{path} reads the same page");
    }
    let default_page = send(rust.port, &Call::new("GET", "/tasks")).await.json();
    assert_eq!(
        number_at(&default_page, &["limit"]),
        Some(5.0),
        "the default page fits within maxTaskPageSize"
    );
    for call in [
        Call::new("POST", "/tasks/no-such-task/_cancel"),
        Call::new("POST", "/tasks/%2E%2E/_cancel"),
    ] {
        let (mine, theirs) = same_status_and_code(rust.port, reference.port, &call).await;
        assert_eq!(mine.json(), theirs.json());
    }

    reference.stop().await;
    rust.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cancelled_import_stops_between_batches_and_keeps_what_it_wrote() {
    let lines = article_lines(SLOW_IMPORT_DOCUMENTS);
    let body = ndjson(&lines);
    let rust = Served::start(Narsil::new(), slow_import_options(1)).await;
    create_in_engine(&rust.engine, "articles", ARTICLE_SCHEMA);
    let reference = ReferenceServer::start(slow_import_spec(1.0)).await;
    create_over_http(reference.port, "articles", ARTICLE_SCHEMA).await;

    let id = start_slow_import(rust.port, &body).await;
    let reference_id = start_slow_import(reference.port, &body).await;

    let second = ndjson_call("/indexes/articles/import", "{}\n");
    let (mine, theirs) = same_status_and_code(rust.port, reference.port, &second).await;
    assert_eq!(mine.status, 429, "a second task waits for the first");
    assert_eq!(mine.json(), theirs.json());
    let optimize = Call::new("POST", "/indexes/articles/vectors/_optimize");
    let refused = send(rust.port, &optimize).await;
    assert_eq!(
        (refused.status, refused.error_code().as_deref()),
        (429, Some("TOO_MANY_REQUESTS")),
        "every route that starts a task honours maxConcurrentTasks"
    );

    wait_for_progress(rust.port, &id, 1.0).await;
    wait_for_progress(reference.port, &reference_id, 1.0).await;
    let cancel_path = format!("/tasks/{id}/_cancel");
    let reference_cancel_path = format!("/tasks/{reference_id}/_cancel");
    let cancelling = send(rust.port, &Call::new("POST", &cancel_path)).await;
    let reference_cancelling =
        send(reference.port, &Call::new("POST", &reference_cancel_path)).await;
    assert_eq!(cancelling.status, 202);
    assert_eq!(reference_cancelling.status, 202);
    assert_eq!(
        text_at(&cancelling.json(), &["status"]).as_deref(),
        Some("running")
    );
    assert!(number_at(&cancelling.json(), &["cancelRequestedAt"]).is_some());

    let stopped = wait_for_task(rust.port, &id).await;
    let reference_stopped = wait_for_task(reference.port, &reference_id).await;
    assert_eq!(text_at(&stopped, &["status"]).as_deref(), Some("cancelled"));
    assert_eq!(
        text_at(&reference_stopped, &["status"]).as_deref(),
        Some("cancelled")
    );
    assert_eq!(at(&stopped, &["error"]), None);
    assert_eq!(at(&stopped, &["result"]), None);
    let indexed = number_at(&stopped, &["progress", "indexed"]).expect("progress stays");
    assert!(indexed >= 1.0 && indexed < SLOW_IMPORT_DOCUMENTS as f64);
    let ids: Vec<String> = (0..SLOW_IMPORT_DOCUMENTS)
        .map(|serial| format!("article-{serial}"))
        .collect();
    let stored = stored_ids(&rust.engine, "articles", &ids);
    assert_eq!(
        stored.len() as f64,
        indexed,
        "the final progress counts exactly the documents written"
    );
    assert_eq!(
        stored,
        ids[..stored.len()].to_vec(),
        "the import wrote a prefix of the body"
    );

    let mine = send(rust.port, &Call::new("POST", &cancel_path)).await;
    let theirs = send(reference.port, &Call::new("POST", &reference_cancel_path)).await;
    assert_eq!(
        (mine.status, theirs.status),
        (409, 409),
        "a finished task cannot stop again"
    );
    assert_eq!(
        code_and_details(&mine.json()),
        code_and_details(&theirs.json())
    );

    let accepted = send(rust.port, &optimize).await;
    assert_eq!(accepted.status, 202, "the finished task frees its slot");

    reference.stop().await;
    rust.stop().await;
}

fn code_and_details(reply: &Value) -> (Option<Value>, Option<Value>) {
    (
        at(reply, &["error", "code"]).cloned(),
        at(reply, &["error", "details"]).cloned(),
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn the_task_list_pages_newest_first_and_filters_by_type_and_status() {
    let rust = Served::start(Narsil::new(), slow_import_options(4)).await;
    create_in_engine(&rust.engine, "articles", ARTICLE_SCHEMA);
    let reference = ReferenceServer::start(slow_import_spec(4.0)).await;
    create_over_http(reference.port, "articles", ARTICLE_SCHEMA).await;

    for port in [rust.port, reference.port] {
        let mut started = Vec::new();
        for _ in 0..3 {
            let reply = send(
                port,
                &Call::new("POST", "/indexes/articles/_rebuild-analysis"),
            )
            .await;
            assert_eq!(reply.status, 202);
            let id = text_at(&reply.json(), &["id"]).expect("the record has an id");
            wait_for_task(port, &id).await;
            started.push(id);
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        let first = send(
            port,
            &Call::new("GET", "/tasks?type=rebuildAnalysis&limit=2"),
        )
        .await
        .json();
        assert_eq!(
            page_shape(&first),
            (Some(3.0), Some(0.0), Some(2.0), Some(Value::Number(2.0)))
        );
        let listed: Vec<Option<String>> = tasks_of(&first)
            .iter()
            .map(|task| text_at(task, &["id"]))
            .collect();
        assert_eq!(
            listed,
            vec![Some(started[2].clone()), Some(started[1].clone())],
            "the newest task comes first"
        );
        let last = send(port, &Call::new("GET", "/tasks?from=2&limit=2"))
            .await
            .json();
        assert_eq!(
            page_shape(&last),
            (Some(3.0), Some(2.0), Some(2.0), Some(Value::Null))
        );
        let none = send(
            port,
            &Call::new("GET", "/tasks?status=failed,cancelled&limit=5"),
        )
        .await
        .json();
        assert_eq!(number_at(&none, &["total"]), Some(0.0));
        let elsewhere = send(port, &Call::new("GET", "/tasks?indexName=other&limit=5"))
            .await
            .json();
        assert_eq!(number_at(&elsewhere, &["total"]), Some(0.0));
        let succeeded = send(
            port,
            &Call::new("GET", "/tasks?status=succeeded&indexName=articles&limit=5"),
        )
        .await
        .json();
        assert_eq!(number_at(&succeeded, &["total"]), Some(3.0));
    }

    reference.stop().await;
    rust.stop().await;
}
