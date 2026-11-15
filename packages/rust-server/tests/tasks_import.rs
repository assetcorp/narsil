mod support;
mod tasks_common;

use narsil::{Narsil, Value};
use narsil_server::{ServerLimits, ServerOptions};
use support::{Call, ReferenceServer, decode_json, object, same_status_and_code, send};
use tasks_common::{
    ARTICLE_SCHEMA, Served, article_lines, at, create_in_engine, create_over_http, json_of,
    keys_of, ndjson, ndjson_call, number_at, stored_ids, text_at, wait_for_task,
};

const IMPORT_PATH: &str = "/indexes/articles/documents/_import";

fn error_summary(error: &Value) -> (Option<f64>, Option<String>, Option<String>) {
    (
        number_at(error, &["line"]),
        text_at(error, &["docId"]),
        text_at(error, &["code"]),
    )
}

fn errors_of(result: &Value) -> Vec<(Option<f64>, Option<String>, Option<String>)> {
    match at(result, &["errors"]) {
        Some(Value::Array(errors)) => errors.iter().map(error_summary).collect(),
        _ => Vec::new(),
    }
}

fn reference_spec(limits: Value) -> Value {
    object(vec![("limits", limits)])
}

async fn count_over_http(port: u16, index: &str) -> f64 {
    let reply = send(port, &Call::new("GET", &format!("/indexes/{index}/count"))).await;
    number_at(&reply.json(), &["count"]).expect("the count route answers a count")
}

#[tokio::test(flavor = "multi_thread")]
async fn an_inline_import_reports_every_refused_line_and_keeps_the_first_copy_of_a_repeated_id() {
    let lines = [
        r#"{"id":"a1","title":"First","views":1}"#,
        "not json",
        "[1,2]",
        "",
        r#"{"id":"a2","title":"Second","views":"many"}"#,
        "{\"id\":\"a1\",\"title\":\"First again\",\"views\":2}\r",
        r#"{"id":"a3","title":"Third","views":3}"#,
        "   ",
        r#""text""#,
    ];
    let body = lines.join("\n");
    let rust = Served::start(Narsil::new(), ServerOptions::default()).await;
    create_in_engine(&rust.engine, "articles", ARTICLE_SCHEMA);
    let reference = ReferenceServer::start(object(vec![])).await;
    create_over_http(reference.port, "articles", ARTICLE_SCHEMA).await;

    let (mine, theirs) =
        same_status_and_code(rust.port, reference.port, &ndjson_call(IMPORT_PATH, &body)).await;
    assert_eq!(mine.status, 200);
    let (mine, theirs) = (mine.json(), theirs.json());
    let expected_errors = vec![
        (Some(2.0), None, Some("INVALID_JSON".to_string())),
        (Some(3.0), None, Some("INVALID_REQUEST".to_string())),
        (Some(7.0), None, Some("INVALID_JSON".to_string())),
        (Some(8.0), None, Some("INVALID_REQUEST".to_string())),
        (
            None,
            Some("a2".to_string()),
            errors_of(&theirs).get(4).and_then(|error| error.2.clone()),
        ),
        (
            None,
            Some("a1".to_string()),
            errors_of(&theirs).get(5).and_then(|error| error.2.clone()),
        ),
    ];
    assert_eq!(
        errors_of(&mine),
        expected_errors,
        "Rust reports each refusal in line order"
    );
    assert_eq!(
        errors_of(&theirs),
        expected_errors,
        "TypeScript reports the same refusals"
    );
    for result in [&mine, &theirs] {
        assert_eq!(number_at(result, &["indexed"]), Some(2.0));
        assert_eq!(number_at(result, &["failed"]), Some(6.0));
        assert_eq!(at(result, &["errorsTruncated"]), Some(&Value::Bool(false)));
    }
    let candidates: Vec<String> = ["a1", "a2", "a3"].iter().map(|id| id.to_string()).collect();
    assert_eq!(
        stored_ids(&rust.engine, "articles", &candidates),
        vec!["a1".to_string(), "a3".to_string()]
    );
    let first = rust
        .engine
        .get("articles", "a1")
        .expect("the read succeeds")
        .expect("a1 is stored");
    assert_eq!(
        first.get("title"),
        Some(&Value::String("First".to_string())),
        "the repeated id leaves the first copy in place"
    );
    assert_eq!(count_over_http(reference.port, "articles").await, 2.0);

    reference.stop().await;
    rust.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_import_limits_refuse_at_the_same_boundaries_as_the_typescript_server() {
    let limits = ServerLimits {
        max_import_errors: Some(2),
        import_batch_size: Some(2),
        max_line_bytes: Some(80),
        max_import_bytes: Some(4_096),
        ..ServerLimits::default()
    };
    let rust = Served::start(
        Narsil::new(),
        ServerOptions {
            limits,
            ..ServerOptions::default()
        },
    )
    .await;
    create_in_engine(&rust.engine, "articles", ARTICLE_SCHEMA);
    let reference = ReferenceServer::start(reference_spec(object(vec![
        ("maxImportErrors", Value::Number(2.0)),
        ("importBatchSize", Value::Number(2.0)),
        ("maxLineBytes", Value::Number(80.0)),
        ("maxImportBytes", Value::Number(4_096.0)),
    ])))
    .await;
    create_over_http(reference.port, "articles", ARTICLE_SCHEMA).await;

    let garbage = ndjson(
        &(0..5)
            .map(|serial| format!("bad line {serial}"))
            .collect::<Vec<_>>(),
    );
    let (mine, theirs) = same_status_and_code(
        rust.port,
        reference.port,
        &ndjson_call(IMPORT_PATH, &garbage),
    )
    .await;
    assert_eq!(
        mine.json(),
        theirs.json(),
        "both cap the reported errors at two"
    );
    assert_eq!(number_at(&mine.json(), &["failed"]), Some(5.0));
    assert_eq!(
        at(&mine.json(), &["errorsTruncated"]),
        Some(&Value::Bool(true))
    );

    let mut long = article_lines(5);
    long[3] = format!(r#"{{"id":"long","title":"{}"}}"#, "x".repeat(90));
    let (mine, theirs) = same_status_and_code(
        rust.port,
        reference.port,
        &ndjson_call(IMPORT_PATH, &ndjson(&long)),
    )
    .await;
    assert_eq!(mine.status, 413);
    assert_eq!(
        mine.json(),
        theirs.json(),
        "both name line 4 as the long line"
    );
    assert_eq!(
        stored_ids(&rust.engine, "articles", &article_lines_ids(5)),
        vec!["article-0".to_string(), "article-1".to_string()],
        "the batch before the long line is written and nothing after it"
    );
    assert_eq!(count_over_http(reference.port, "articles").await, 2.0);

    let oversized = ndjson(&article_lines(80));
    assert!(oversized.len() > 4_096);
    for call in [
        ndjson_call(IMPORT_PATH, &oversized),
        ndjson_call(IMPORT_PATH, ""),
        ndjson_call(
            "/indexes/missing/documents/_import",
            &ndjson(&article_lines(1)),
        ),
        ndjson_call(
            "/indexes/missing/documents/_import?async=true",
            &ndjson(&article_lines(1)),
        ),
    ] {
        let (mine, theirs) = same_status_and_code(rust.port, reference.port, &call).await;
        assert_eq!(mine.json(), theirs.json(), "{} answers alike", call.path);
    }
    let (mine, theirs) = same_status_and_code(
        rust.port,
        reference.port,
        &ndjson_call("/indexes/missing/documents/_import", "only garbage\n"),
    )
    .await;
    assert_eq!(
        mine.status, 200,
        "a body with no document never reaches the index"
    );
    assert_eq!(mine.json(), theirs.json());

    reference.stop().await;
    rust.stop().await;
}

fn article_lines_ids(count: usize) -> Vec<String> {
    (0..count)
        .map(|serial| format!("article-{serial}"))
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn an_asynchronous_import_finishes_as_a_task_with_the_inline_result() {
    let mut lines = article_lines(500);
    lines.insert(100, "{broken".to_string());
    lines.push(lines[7].clone());
    let body = ndjson(&lines);
    let rust = Served::start(Narsil::new(), ServerOptions::default()).await;
    create_in_engine(&rust.engine, "articles", ARTICLE_SCHEMA);
    let reference = ReferenceServer::start(object(vec![])).await;
    create_over_http(reference.port, "articles", ARTICLE_SCHEMA).await;

    let path = format!("{IMPORT_PATH}?async=true");
    let (mine, theirs) =
        same_status_and_code(rust.port, reference.port, &ndjson_call(&path, &body)).await;
    assert_eq!(mine.status, 202);
    let (accepted, reference_accepted) = (mine.json(), theirs.json());
    assert_eq!(keys_of(&accepted), keys_of(&reference_accepted));
    assert_eq!(text_at(&accepted, &["type"]).as_deref(), Some("import"));
    assert_eq!(text_at(&accepted, &["status"]).as_deref(), Some("running"));
    assert_eq!(
        at(&accepted, &["progress"]),
        at(&reference_accepted, &["progress"])
    );

    let id = text_at(&accepted, &["id"]).expect("the record has an id");
    let reference_id = text_at(&reference_accepted, &["id"]).expect("the record has an id");
    let finished = wait_for_task(rust.port, &id).await;
    let reference_finished = wait_for_task(reference.port, &reference_id).await;
    assert_eq!(keys_of(&finished), keys_of(&reference_finished));
    assert_eq!(
        text_at(&finished, &["status"]).as_deref(),
        Some("succeeded")
    );
    assert_eq!(
        at(&finished, &["result"]),
        at(&reference_finished, &["result"]),
        "both report the repeated document with the engine's details"
    );
    assert_eq!(
        at(&finished, &["progress"]),
        at(&reference_finished, &["progress"])
    );
    assert_eq!(number_at(&finished, &["result", "indexed"]), Some(500.0));
    assert_eq!(number_at(&finished, &["result", "failed"]), Some(2.0));
    assert_eq!(
        number_at(&finished, &["progress", "bytesProcessed"]),
        Some(body.len() as f64)
    );
    assert!(number_at(&finished, &["completedAt"]) >= number_at(&finished, &["startedAt"]));

    let mut expected: Vec<String> = lines
        .iter()
        .filter_map(|line| decode_json(line).ok())
        .filter_map(|document| text_at(&document, &["id"]))
        .collect();
    expected.sort();
    expected.dedup();
    assert_eq!(expected.len(), 500);
    assert_eq!(stored_ids(&rust.engine, "articles", &expected), expected);
    assert_eq!(rust.engine.count_documents("articles").ok(), Some(500));
    assert_eq!(count_over_http(reference.port, "articles").await, 500.0);
    assert_eq!(
        rust.engine
            .get("articles", "article-7")
            .ok()
            .flatten()
            .map(Value::Object),
        Some(json_of(&lines[7]))
    );

    reference.stop().await;
    rust.stop().await;
}
