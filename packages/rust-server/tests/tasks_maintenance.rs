mod support;
mod tasks_common;

use narsil::{Narsil, Value};
use narsil_server::{ServerLimits, ServerOptions};
use support::{Call, ReferenceServer, Reply, object, parsed, same_status_and_code, send};
use tasks_common::{
    ARTICLE_SCHEMA, Served, article_lines, at, create_in_engine, create_over_http, keys_of, ndjson,
    ndjson_call, number_at, stored_ids, text_at, wait_for_task, without_engine_details,
};

const MAX_RESTORE_BYTES: u64 = 1024 * 1024;

struct Pair {
    rust: Served,
    reference: ReferenceServer,
}

impl Pair {
    async fn start() -> Pair {
        let rust = Served::start(
            Narsil::new(),
            ServerOptions {
                limits: ServerLimits {
                    max_restore_bytes: Some(MAX_RESTORE_BYTES),
                    ..ServerLimits::default()
                },
                ..ServerOptions::default()
            },
        )
        .await;
        create_in_engine(&rust.engine, "articles", ARTICLE_SCHEMA);
        let reference = ReferenceServer::start(object(vec![(
            "limits",
            object(vec![(
                "maxRestoreBytes",
                Value::Number(MAX_RESTORE_BYTES as f64),
            )]),
        )]))
        .await;
        create_over_http(reference.port, "articles", ARTICLE_SCHEMA).await;
        let body = ndjson(&article_lines(50));
        for port in [rust.port, reference.port] {
            let reply = send(
                port,
                &ndjson_call("/indexes/articles/documents/_import", &body),
            )
            .await;
            assert_eq!(reply.status, 200);
        }
        Pair { rust, reference }
    }

    async fn refused_alike(&self, call: &Call<'_>) {
        let (mine, theirs) = same_status_and_code(self.rust.port, self.reference.port, call).await;
        assert!(
            mine.status >= 400,
            "{} {} is refused",
            call.method,
            call.path
        );
        assert_eq!(
            without_engine_details(&mine.json()),
            without_engine_details(&theirs.json()),
            "{} {} carries the same error",
            call.method,
            call.path
        );
    }

    async fn finished_alike(&self, call: &Call<'_>) -> (Value, Value) {
        let (mine, theirs) = same_status_and_code(self.rust.port, self.reference.port, call).await;
        assert_eq!(
            mine.status, 202,
            "{} {} starts a task",
            call.method, call.path
        );
        assert_eq!(keys_of(&mine.json()), keys_of(&theirs.json()));
        let finished = finish(self.rust.port, &mine).await;
        let reference_finished = finish(self.reference.port, &theirs).await;
        assert_eq!(
            text_at(&finished, &["status"]),
            text_at(&reference_finished, &["status"]),
            "{} {} ends alike; Rust {finished:?}, TypeScript {reference_finished:?}",
            call.method,
            call.path
        );
        assert_eq!(
            at(&finished, &["error", "code"]),
            at(&reference_finished, &["error", "code"]),
            "{} {} fails with the same code",
            call.method,
            call.path
        );
        assert_eq!(keys_of(&finished), keys_of(&reference_finished));
        (finished, reference_finished)
    }

    async fn stop(self) {
        self.reference.stop().await;
        self.rust.stop().await;
    }
}

async fn finish(port: u16, accepted: &Reply) -> Value {
    let id = text_at(&accepted.json(), &["id"]).expect("the record has an id");
    wait_for_task(port, &id).await
}

fn json_call<'a>(path: &'a str, body: &str) -> Call<'a> {
    Call::new("POST", path)
        .header("content-type", "application/json")
        .raw(body.to_string())
}

fn archive_call<'a>(path: &'a str, body: Vec<u8>) -> Call<'a> {
    Call::new("POST", path)
        .header("content-type", "application/octet-stream")
        .raw(body)
}

#[tokio::test(flavor = "multi_thread")]
async fn the_index_maintenance_routes_check_their_bodies_and_the_index_in_the_same_order() {
    let pair = Pair::start().await;
    let refused = [
        json_call("/indexes/articles/_change-analysis", "[]"),
        json_call("/indexes/articles/_change-analysis", "not json"),
        json_call("/indexes/articles/_change-analysis", r#"{"colour":"red"}"#),
        json_call("/indexes/articles/_change-analysis", r#"{"language":5}"#),
        json_call("/indexes/articles/_change-analysis", r#"{"language":null}"#),
        json_call("/indexes/articles/_change-analysis", r#"{"tokenizer":5}"#),
        json_call("/indexes/articles/_change-analysis", r#"{"stopWords":[1]}"#),
        json_call("/indexes/articles/_change-analysis", r#"{"stopWords":5}"#),
        json_call("/indexes/missing/_change-analysis", r#"{"colour":"red"}"#),
        json_call("/indexes/missing/_change-analysis", "{}"),
        json_call("/indexes/articles/_rebalance", ""),
        json_call("/indexes/articles/_rebalance", "5"),
        json_call(
            "/indexes/articles/_rebalance",
            r#"{"targetPartitionCount":0}"#,
        ),
        json_call(
            "/indexes/articles/_rebalance",
            r#"{"targetPartitionCount":1.5}"#,
        ),
        json_call(
            "/indexes/articles/_rebalance",
            r#"{"targetPartitionCount":"2"}"#,
        ),
        json_call(
            "/indexes/articles/_rebalance",
            r#"{"targetPartitionCount":-3}"#,
        ),
        json_call(
            "/indexes/missing/_rebalance",
            r#"{"targetPartitionCount":2}"#,
        ),
        json_call("/indexes/articles/vectors/_optimize", "{"),
        json_call("/indexes/missing/vectors/_optimize", ""),
        Call::new("POST", "/indexes/missing/_rebuild-analysis"),
        Call::new("POST", "/indexes/missing/query-suggestions/build"),
        Call::new("POST", "/indexes/articles/query-suggestions/build"),
        archive_call("/indexes/articles/restore", Vec::new()),
        archive_call("/indexes/articles/import", Vec::new()),
        archive_call(
            "/indexes/articles/restore",
            vec![0; (MAX_RESTORE_BYTES + 1) as usize],
        ),
    ];
    for call in &refused {
        pair.refused_alike(call).await;
    }
    pair.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn each_maintenance_task_ends_as_the_typescript_task_ends() {
    let pair = Pair::start().await;
    for call in [
        json_call(
            "/indexes/articles/_change-analysis",
            r#"{"stopWords":["the"]}"#,
        ),
        json_call(
            "/indexes/articles/_change-analysis",
            r#"{"language":"klingon"}"#,
        ),
        json_call(
            "/indexes/articles/_change-analysis",
            r#"{"tokenizer":null,"stopWords":null}"#,
        ),
        json_call(
            "/indexes/articles/_rebalance",
            r#"{"targetPartitionCount":2}"#,
        ),
        json_call("/indexes/articles/vectors/_optimize", ""),
        json_call(
            "/indexes/articles/vectors/_optimize",
            r#"{"field":"embedding"}"#,
        ),
        Call::new("POST", "/indexes/articles/_rebuild-analysis"),
    ] {
        pair.finished_alike(&call).await;
    }
    let (finished, reference_finished) = pair
        .finished_alike(&json_call(
            "/indexes/articles/vectors/_optimize",
            r#"{"field":5}"#,
        ))
        .await;
    assert_eq!(
        text_at(&finished, &["error", "message"]),
        text_at(&reference_finished, &["error", "message"])
    );
    assert_eq!(
        pair.rust.engine.count_documents("articles").ok(),
        Some(50),
        "maintenance leaves every document in place"
    );
    pair.stop().await;
}

async fn download(port: u16, path: &str) -> Vec<u8> {
    let reply = send(port, &Call::new("GET", path)).await;
    assert_eq!(reply.status, 200, "the reference server answers {path}");
    reply.body.to_vec()
}

#[tokio::test(flavor = "multi_thread")]
async fn restores_and_document_imports_read_the_spooled_body_and_refuse_damaged_files() {
    let pair = Pair::start().await;
    let snapshot = download(pair.reference.port, "/indexes/articles/snapshot").await;
    let export = download(pair.reference.port, "/indexes/articles/export").await;

    let (restored, _) = pair
        .finished_alike(&archive_call("/indexes/restored/restore", snapshot.clone()))
        .await;
    assert_eq!(
        text_at(&restored, &["status"]).as_deref(),
        Some("succeeded")
    );
    let ids: Vec<String> = (0..50).map(|serial| format!("article-{serial}")).collect();
    assert_eq!(stored_ids(&pair.rust.engine, "restored", &ids), ids);

    let (imported, reference_imported) = pair
        .finished_alike(&archive_call("/indexes/copied/import", export.clone()))
        .await;
    assert_eq!(
        at(&imported, &["result"]),
        at(&reference_imported, &["result"])
    );
    assert_eq!(number_at(&imported, &["result", "indexed"]), Some(50.0));
    assert_eq!(stored_ids(&pair.rust.engine, "copied", &ids), ids);
    assert_eq!(
        pair.rust
            .engine
            .get("copied", "article-9")
            .ok()
            .flatten()
            .map(Value::Object),
        Some(parsed(
            r#"{"id":"article-9","title":"Field notes 9","views":9}"#
        ))
    );

    let mut truncated = snapshot.clone();
    truncated.truncate(snapshot.len() / 2);
    let mut flipped = snapshot.clone();
    let middle = flipped.len() / 2;
    for byte in flipped.iter_mut().skip(middle).take(64) {
        *byte ^= 0x5a;
    }
    let mut bad_lines = export.clone();
    bad_lines.extend_from_slice(b"not a document\n{\"id\":\"extra\"}\n");
    for (call, ending) in [
        (
            archive_call(
                "/indexes/articles/restore",
                b"not a snapshot archive".to_vec(),
            ),
            "failed",
        ),
        (
            archive_call("/indexes/articles/restore", truncated),
            "failed",
        ),
        (archive_call("/indexes/articles/restore", flipped), "failed"),
        (
            archive_call("/indexes/fresh/import", b"not an export\n".to_vec()),
            "failed",
        ),
        (
            archive_call("/indexes/articles/import", bad_lines),
            "succeeded",
        ),
    ] {
        let (finished, reference_finished) = pair.finished_alike(&call).await;
        assert_eq!(text_at(&finished, &["status"]).as_deref(), Some(ending));
        assert_eq!(
            at(&finished, &["result"]).map(without_engine_details),
            at(&reference_finished, &["result"]).map(without_engine_details),
            "{} reports the same refusals",
            call.path
        );
    }
    assert_eq!(
        stored_ids(&pair.rust.engine, "articles", &ids),
        ids,
        "a damaged restore leaves the index as it was"
    );
    assert_eq!(
        pair.rust.engine.count_documents("articles").ok(),
        Some(51),
        "the export import adds its one new document beside the 50"
    );
    pair.stop().await;
}
