mod support;

use std::fmt::Write;
use std::time::{Duration, Instant};

use narsil::{IndexConfig, Narsil, Value};
use narsil_server::ServerOptions;
use support::{Call, ReferenceServer, RustServer, object, parsed, send};

const NAMED_KEYS: usize = 400_000;
const NUMERIC_KEYS: usize = 300_000;
const ANSWER_DEADLINE: Duration = Duration::from_secs(10);
const GIVE_UP_AFTER: Duration = Duration::from_secs(120);

fn wide_object() -> String {
    let mut body = String::from("{");
    for serial in 0..NAMED_KEYS {
        write!(body, "\"k{serial}\":0,").expect("a string takes text");
    }
    for serial in (0..NUMERIC_KEYS).rev() {
        write!(body, "\"{serial}\":0,").expect("a string takes text");
    }
    body.push_str("\"k0\":1}");
    body
}

const SCHEMA: &str = r#"{"title":"string"}"#;

async fn create_over_http(port: u16) {
    let created = send(
        port,
        &Call::new("POST", "/indexes").json(&object(vec![
            ("name", Value::from("articles")),
            ("config", object(vec![("schema", parsed(SCHEMA))])),
        ])),
    )
    .await;
    assert!(
        created.status < 300,
        "the reference server creates the index"
    );
}

fn engine_with_index() -> Narsil {
    let engine = Narsil::new();
    engine
        .create_index(
            "articles",
            IndexConfig {
                schema: parsed(SCHEMA),
                ..IndexConfig::default()
            },
        )
        .expect("the engine creates the index");
    engine
}

async fn timed(port: u16, call: &Call<'_>) -> (u16, Option<String>, Duration) {
    let started = Instant::now();
    let reply = tokio::time::timeout(GIVE_UP_AFTER, send(port, call))
        .await
        .unwrap_or_else(|_| panic!("the server answered within {GIVE_UP_AFTER:?}"));
    (reply.status, reply.error_code(), started.elapsed())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_body_with_hundreds_of_thousands_of_keys_is_answered_as_fast_as_the_typescript_server() {
    let rust = RustServer::start(engine_with_index(), ServerOptions::default()).await;
    let reference = ReferenceServer::start(object(vec![])).await;
    create_over_http(reference.port).await;
    let body = wide_object();
    let call = Call::new("POST", "/indexes/articles/_change-analysis")
        .header("content-type", "application/json")
        .raw(body);

    let (reference_status, reference_code, reference_took) = timed(reference.port, &call).await;
    let (status, code, took) = timed(rust.port, &call).await;

    assert_eq!(
        (status, code),
        (reference_status, reference_code),
        "both servers refuse the body alike"
    );
    assert!(
        took < ANSWER_DEADLINE,
        "the Rust server took {took:?}, while the TypeScript server took {reference_took:?}"
    );
    reference.stop().await;
    rust.stop().await;
}
