mod support;

use std::path::Path;

use narsil::Value;
use narsil_server::{FeedOptions, ServerOptions};
use support::{
    ReferenceServer, RustServer, ScratchDirectory, TOKEN, decode_json, object, token_hook,
};
use tokio::process::Command;

async fn walk(port: u16) -> Vec<Value> {
    let script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/typescript_client_walk.mjs");
    let output = Command::new("node")
        .arg(script)
        .arg(support::repository_root())
        .arg(format!("http://127.0.0.1:{port}"))
        .arg(TOKEN)
        .output()
        .await
        .expect("node runs the TypeScript client");
    assert!(
        output.status.success(),
        "the TypeScript client walk failed against port {port}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    match decode_json(&String::from_utf8_lossy(&output.stdout)) {
        Ok(Value::Array(steps)) => steps,
        other => panic!("the walk writes a list of steps, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn every_typescript_client_call_answers_from_the_rust_server_as_from_the_typescript_server() {
    let rust_directory = ScratchDirectory::new("client-walk-rust");
    let reference_directory = ScratchDirectory::new("client-walk-reference");
    let rust = RustServer::durable(
        rust_directory.path(),
        token_hook(ServerOptions {
            sync: Some(FeedOptions::default()),
            changes: Some(FeedOptions::default()),
            ..ServerOptions::default()
        }),
    )
    .await;
    let reference = ReferenceServer::start(object(vec![
        ("token", Value::String(TOKEN.to_string())),
        (
            "directory",
            Value::String(reference_directory.path().to_string_lossy().into_owned()),
        ),
        ("sync", object(vec![])),
        ("changes", object(vec![])),
    ]))
    .await;

    let mine = walk(rust.port).await;
    let theirs = walk(reference.port).await;
    let differing: Vec<String> = mine
        .iter()
        .zip(&theirs)
        .filter(|(left, right)| left != right)
        .map(|(left, right)| format!("Rust {left:?}\nTypeScript {right:?}"))
        .collect();
    assert!(
        differing.is_empty() && mine.len() == theirs.len(),
        "the TypeScript client sees {} differing steps:\n{}",
        differing.len(),
        differing.join("\n\n")
    );

    reference.stop().await;
    rust.stop().await;
}
