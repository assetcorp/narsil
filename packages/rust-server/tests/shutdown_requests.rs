#![recursion_limit = "256"]

mod support;

use std::sync::Arc;
use std::time::Duration;

use narsil_server::{RequestDecision, ServerOptions};
use tokio::sync::Notify;

use support::{Call, RustServer, parsed, send};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_shutdown_calls_both_wait_for_an_accepted_request() {
    let arrived = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let observed = Arc::clone(&arrived);
    let held = Arc::clone(&release);
    let server = RustServer::in_memory(ServerOptions {
        on_request: Some(Arc::new(move |_| {
            let observed = Arc::clone(&observed);
            let held = Arc::clone(&held);
            async move {
                observed.notify_one();
                held.notified().await;
                Ok(RequestDecision::Allow)
            }
        })),
        ..ServerOptions::default()
    })
    .await;
    let port = server.port;
    let server = Arc::new(server.server);
    let request = tokio::spawn(async move {
        send(
            port,
            &Call::new("POST", "/indexes").json(&parsed(
                r#"{"name":"catalogue","config":{"schema":{"title":"string"}}}"#,
            )),
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(5), arrived.notified())
        .await
        .expect("the request reaches the hook");
    let first_server = Arc::clone(&server);
    let first = tokio::spawn(async move { first_server.shutdown().await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let second_server = Arc::clone(&server);
    let second = tokio::spawn(async move { second_server.shutdown().await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let returned_early = first.is_finished() || second.is_finished();
    release.notify_one();
    let response = request.await.expect("the request completes");
    first
        .await
        .expect("the first shutdown completes")
        .expect("the engine closes");
    second
        .await
        .expect("the second shutdown completes")
        .expect("the engine closes once");
    assert!(
        !returned_early,
        "both shutdown calls drain the accepted request"
    );
    assert_eq!(
        response.status, 201,
        "the engine remains open through the request"
    );
}
