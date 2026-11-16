mod support;

use narsil::Value;
use narsil_server::ServerOptions;
use support::{Call, ReferenceServer, RustServer, ScratchDirectory, object, parsed, send};

const CREATED_NAMES: [&str; 6] = ["zeta", "a.b", "alpha", "a", "m-1", "b_2"];
const CLOSED_NAME: &str = "alpha";
const RECREATED_NAME: &str = "zeta";
const LIVE_ORDER: [&str; 6] = ["a.b", "alpha", "a", "m-1", "b_2", "zeta"];
const RECOVERED_ORDER: [&str; 6] = ["a.b", "a", "alpha", "b_2", "m-1", "zeta"];

async fn succeeds(port: u16, call: Call<'_>, what: &str) {
    let reply = send(port, &call).await;
    assert!(
        reply.status < 300,
        "{what} succeeds: {} {}",
        reply.status,
        String::from_utf8_lossy(&reply.body)
    );
}

async fn create(port: u16, name: &str) {
    let body = object(vec![
        ("name", Value::from(name)),
        ("config", parsed(r#"{"schema":{"title":"string"}}"#)),
    ]);
    succeeds(
        port,
        Call::new("POST", "/indexes").json(&body),
        &format!("creating {name}"),
    )
    .await;
}

async fn arrange(port: u16) {
    for name in CREATED_NAMES {
        create(port, name).await;
    }
    let closing = format!("/indexes/{CLOSED_NAME}/_close");
    succeeds(port, Call::new("POST", &closing), "closing an index").await;
    let dropping = format!("/indexes/{RECREATED_NAME}");
    succeeds(port, Call::new("DELETE", &dropping), "dropping an index").await;
    create(port, RECREATED_NAME).await;
}

async fn read(port: u16, path: &str) -> Value {
    let reply = send(port, &Call::new("GET", path)).await;
    assert_eq!(reply.status, 200, "GET {path} succeeds");
    reply.json()
}

fn names_in(listing: &Value, list: &str, key: &str) -> Vec<String> {
    listing
        .pointer(list)
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("the answer lists {list}"))
        .iter()
        .map(|entry| {
            entry
                .pointer(key)
                .and_then(Value::as_str)
                .unwrap_or_else(|| panic!("each {list} entry has a name"))
                .to_string()
        })
        .collect()
}

async fn compare(rust: u16, reference: u16, wanted: [&str; 6], moment: &str) {
    let (mine, theirs) = (
        read(rust, "/indexes").await,
        read(reference, "/indexes").await,
    );
    assert_eq!(
        names_in(&theirs, "indexes", "name"),
        wanted,
        "the TypeScript server lists the indexes {moment} in this order"
    );
    assert_eq!(
        mine, theirs,
        "the Rust server lists the indexes {moment} as the TypeScript server does"
    );
    let (mine, theirs) = (
        read(rust, "/stats/memory").await,
        read(reference, "/stats/memory").await,
    );
    assert_eq!(
        names_in(&mine, "workerCopies", "indexName"),
        names_in(&theirs, "workerCopies", "indexName"),
        "the Rust server lists the worker copies {moment} in the order of the TypeScript server"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn indexes_are_listed_in_creation_order_and_after_a_restart_in_the_typescript_order() {
    let rust_directory = ScratchDirectory::new("index-order-rust");
    let reference_directory = ScratchDirectory::new("index-order-reference");
    let reference_spec = || {
        object(vec![(
            "directory",
            Value::from(reference_directory.path().to_string_lossy().as_ref()),
        )])
    };

    let rust = RustServer::durable(rust_directory.path(), ServerOptions::default()).await;
    let reference = ReferenceServer::start(reference_spec()).await;
    arrange(rust.port).await;
    arrange(reference.port).await;
    compare(rust.port, reference.port, LIVE_ORDER, "while they run").await;
    rust.stop().await;
    reference.stop().await;

    let rust = RustServer::durable(rust_directory.path(), ServerOptions::default()).await;
    let reference = ReferenceServer::start(reference_spec()).await;
    compare(
        rust.port,
        reference.port,
        RECOVERED_ORDER,
        "after a restart",
    )
    .await;
    rust.stop().await;
    reference.stop().await;
}
