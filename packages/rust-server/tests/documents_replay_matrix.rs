mod documents_replay;
mod support;

use documents_replay::{BODY_LIMIT_BYTES, FETCH_LIMIT_DOCUMENTS, cases, replay, report};
use narsil::Value;
use narsil_server::{ServerLimits, ServerOptions};
use support::{ReferenceServer, RustServer, object};

async fn servers() -> (RustServer, ReferenceServer) {
    let rust = RustServer::in_memory(ServerOptions {
        limits: ServerLimits {
            max_body_bytes: Some(BODY_LIMIT_BYTES as u64),
            max_fetch_documents: Some(FETCH_LIMIT_DOCUMENTS),
            ..ServerLimits::default()
        },
        ..ServerOptions::default()
    })
    .await;
    let reference = ReferenceServer::start(object(vec![(
        "limits",
        object(vec![
            ("maxBodyBytes", Value::Number(BODY_LIMIT_BYTES as f64)),
            (
                "maxFetchDocuments",
                Value::Number(FETCH_LIMIT_DOCUMENTS as f64),
            ),
        ]),
    )]))
    .await;
    (rust, reference)
}

async fn replay_fixture(fixture: &str) -> String {
    let (rust, reference) = servers().await;
    let divergences = replay(rust.port, reference.port, &cases(fixture)).await;
    reference.stop().await;
    rust.stop().await;
    report(&divergences)
}

#[tokio::test(flavor = "multi_thread")]
async fn every_index_config_answers_as_the_typescript_server_does() {
    let divergences = replay_fixture(include_str!("fixtures/documents/index-config.jsonl")).await;
    assert!(divergences.is_empty(), "{divergences}");
}

#[tokio::test(flavor = "multi_thread")]
async fn every_document_write_and_read_answers_as_the_typescript_server_does() {
    let divergences =
        replay_fixture(include_str!("fixtures/documents/document-writes.jsonl")).await;
    assert!(divergences.is_empty(), "{divergences}");
}
