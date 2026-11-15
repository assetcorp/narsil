mod support;

use narsil::Value;
use narsil_server::ServerOptions;
use support::{Call, ReferenceServer, RustServer, object, same_status_and_code, token_hook};

#[tokio::test(flavor = "multi_thread")]
async fn only_the_probes_answer_a_caller_who_fails_the_request_check() {
    let rust = RustServer::in_memory(token_hook(ServerOptions::default())).await;
    let reference = ReferenceServer::start(object(vec![(
        "token",
        Value::String(support::TOKEN.to_string()),
    )]))
    .await;

    for path in ["/livez", "/readyz", "/health", "/version", "/capabilities"] {
        let (mine, theirs) =
            same_status_and_code(rust.port, reference.port, &Call::new("GET", path)).await;
        assert_eq!(mine.status, 200, "{path} answers a caller without a token");
        assert_eq!(theirs.status, 200);
    }

    for path in [
        "/stats/memory",
        "/tasks",
        "/indexes",
        "/cluster",
        "/metrics",
        "/backups",
    ] {
        let (mine, _) =
            same_status_and_code(rust.port, reference.port, &Call::new("GET", path)).await;
        assert_eq!(mine.status, 401, "{path} refuses a caller without a token");
    }
    let (mine, theirs) = same_status_and_code(
        rust.port,
        reference.port,
        &Call::new("GET", "/capabilities").authorized(),
    )
    .await;
    assert_eq!(
        mine.json(),
        theirs.json(),
        "both servers list the same capabilities"
    );

    for call in [
        Call::new("GET", "/no-such-route").authorized(),
        Call::new("DELETE", "/livez").authorized(),
        Call::new("GET", "/indexes/%E0%A4%A/stats").authorized(),
        Call::new("GET", "/indexes/%ZZ/stats"),
        Call::new("GET", "/cluster").authorized(),
        Call::new("GET", "/cluster/health").authorized(),
        Call::new("GET", "/metrics").authorized(),
    ] {
        same_status_and_code(rust.port, reference.port, &call).await;
    }

    reference.stop().await;
    rust.stop().await;
}
