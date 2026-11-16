mod support;
mod tasks_common;

use narsil::{MemoryConfig, Narsil, NarsilConfig, Value};
use narsil_server::ServerOptions;
use support::{Call, Reply, parsed, send};
use tasks_common::{
    ARTICLE_SCHEMA, Served, article_lines, at, create_in_engine, ndjson, ndjson_call, number_at,
    stored_ids, text_at,
};

const BLOCK_BELOW_ANY_RUNNING_PROCESS: f64 = 0.000_001;
const RESUME_BELOW_ANY_RUNNING_PROCESS: f64 = 0.000_000_5;
const PARSE_LARGER_THAN_THE_BLOCK_BYTES: usize = 4 * 1024 * 1024;
const IMPORTED_LINES: usize = 3;

fn reason_of(reply: &Reply) -> Option<String> {
    text_at(&reply.json(), &["error", "details", "reason"])
}

fn tight_engine() -> Narsil {
    let engine = Narsil::open(NarsilConfig {
        memory: Some(MemoryConfig {
            block_writes_above: Some(BLOCK_BELOW_ANY_RUNNING_PROCESS),
            resume_writes_below: Some(RESUME_BELOW_ANY_RUNNING_PROCESS),
        }),
        ..NarsilConfig::default()
    })
    .expect("the engine opens");
    create_in_engine(&engine, "articles", ARTICLE_SCHEMA);
    engine
}

#[tokio::test(flavor = "multi_thread")]
async fn a_body_whose_parse_would_pass_the_memory_block_is_refused_before_it_is_parsed() {
    let served = Served::start(tight_engine(), ServerOptions::default()).await;
    let port = served.port;

    let created = send(
        port,
        &Call::new("POST", "/indexes").json(&parsed(
            r#"{"name":"notes","config":{"schema":{"title":"string"}}}"#,
        )),
    )
    .await;
    assert_eq!(created.status, 429);
    assert_eq!(created.error_code().as_deref(), Some("TOO_MANY_REQUESTS"));
    assert_eq!(
        reason_of(&created).as_deref(),
        Some("parse_would_fill_memory")
    );
    let listed: Vec<String> = served
        .engine
        .list_indexes()
        .into_iter()
        .map(|info| info.name)
        .collect();
    assert_eq!(listed, vec!["articles".to_string()]);

    let stored = send(
        port,
        &Call::new("PUT", "/indexes/articles/documents/kept-out")
            .json(&parsed(r#"{"document":{"title":"harbor","views":1}}"#)),
    )
    .await;
    assert_eq!(stored.status, 429);
    assert_eq!(
        reason_of(&stored).as_deref(),
        Some("parse_would_fill_memory")
    );
    let details = stored.json();
    let block_bytes = number_at(&details, &["error", "details", "blockBytes"]).unwrap_or(f64::NAN);
    let heap_bytes = number_at(&details, &["error", "details", "heapBytes"]).unwrap_or(f64::NAN);
    assert!(heap_bytes > block_bytes, "{details:?}");

    let huge = format!(
        r#"{{"document":{{"title":"{}","views":1}}}}"#,
        "a".repeat(PARSE_LARGER_THAN_THE_BLOCK_BYTES)
    );
    let oversized = send(
        port,
        &Call::new("PUT", "/indexes/articles/documents/kept-out")
            .header("content-type", "application/json")
            .raw(huge),
    )
    .await;
    assert_eq!(oversized.status, 413);
    assert_eq!(oversized.error_code().as_deref(), Some("PAYLOAD_TOO_LARGE"));
    assert_eq!(
        reason_of(&oversized).as_deref(),
        Some("parse_exceeds_memory")
    );

    let lines = article_lines(IMPORTED_LINES);
    let imported = send(
        port,
        &ndjson_call("/indexes/articles/documents/_import", &ndjson(&lines)),
    )
    .await;
    assert_eq!(imported.status, 200);
    let result = imported.json();
    assert_eq!(number_at(&result, &["indexed"]), Some(0.0));
    assert_eq!(number_at(&result, &["failed"]), Some(IMPORTED_LINES as f64));
    let errors = at(&result, &["errors"])
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let refused: Vec<(Option<String>, Option<String>)> = errors
        .iter()
        .map(|error| {
            (
                text_at(error, &["code"]),
                text_at(error, &["details", "reason"]),
            )
        })
        .collect();
    let expected = (
        Some("TOO_MANY_REQUESTS".to_string()),
        Some("parse_would_fill_memory".to_string()),
    );
    assert_eq!(refused, vec![expected; IMPORTED_LINES]);

    let ids: Vec<String> = (0..IMPORTED_LINES)
        .map(|serial| format!("article-{serial}"))
        .collect();
    let candidates = [ids, vec!["kept-out".to_string()]].concat();
    assert_eq!(
        stored_ids(&served.engine, "articles", &candidates),
        Vec::<String>::new()
    );

    let searched = send(
        port,
        &Call::new("POST", "/indexes/articles/search").json(&parsed(r#"{"term":"harbor"}"#)),
    )
    .await;
    assert_eq!(
        searched.status, 200,
        "a read may fill up to 95 percent of the limit"
    );
    served.stop().await;
}
