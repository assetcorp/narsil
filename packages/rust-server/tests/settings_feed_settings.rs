mod settings_support;
mod support;

use narsil::{Map, Value};
use settings_support::{
    INDEX, feed_options, field, reference_spec, rust_durable, same_error, seed, seed_reference,
};
use support::{Call, ReferenceServer, RustServer, ScratchDirectory, send};

const NOTES: usize = 3;
const EPOCH_HEX_DIGITS: usize = 32;

fn put<'a>(path: &'a str, body: &str) -> Call<'a> {
    Call::new("PUT", path)
        .authorized()
        .header("content-type", "application/json")
        .raw(body.to_string())
}

fn without_epoch(status: &Value) -> (Map, Option<Value>) {
    let Value::Object(fields) = status else {
        panic!("a status is an object: {status:?}");
    };
    let mut fields = fields.clone();
    let epoch = fields.insert("epoch", Value::Null);
    (fields, epoch)
}

async fn same_status(rust: u16, reference: u16, path: &str) -> Value {
    let read = Call::new("GET", path).authorized();
    let mine = send(rust, &read).await;
    let theirs = send(reference, &read).await;
    assert_eq!((mine.status, theirs.status), (200, 200));
    let (my_fields, my_epoch) = without_epoch(&mine.json());
    let (their_fields, their_epoch) = without_epoch(&theirs.json());
    assert_eq!(
        my_fields.iter().collect::<Vec<_>>(),
        their_fields.iter().collect::<Vec<_>>(),
        "{path} reports the same fields in the same order"
    );
    match (&my_epoch, &their_epoch) {
        (Some(Value::String(mine)), Some(Value::String(theirs))) => {
            assert_eq!(mine.len(), EPOCH_HEX_DIGITS);
            assert_eq!(theirs.len(), EPOCH_HEX_DIGITS);
            assert!(mine.bytes().all(|byte| byte.is_ascii_hexdigit()));
        }
        (mine, theirs) => assert_eq!(mine, theirs),
    }
    mine.json()
}

const SETTING_BODIES: [&str; 22] = [
    "",
    "{",
    "null",
    "5",
    "\"on\"",
    "true",
    "[]",
    "{}",
    r#"{"enabled":"true"}"#,
    r#"{"enabled":1}"#,
    r#"{"enabled":true,"historyMaxAgeMs":0}"#,
    r#"{"enabled":true,"historyMaxAgeMs":-1}"#,
    r#"{"enabled":true,"historyMaxAgeMs":1.5}"#,
    r#"{"enabled":true,"historyMaxAgeMs":"100"}"#,
    r#"{"enabled":true,"historyMaxAgeMs":null}"#,
    r#"{"enabled":true,"historyMaxAgeMs":9007199254740992}"#,
    r#"{"enabled":true,"historyMaxAgeMs":1e21}"#,
    r#"{"enabled":true,"historyMaxAgeMs":[1,[2,null]]}"#,
    r#"{"enabled":true,"historyMaxBytes":true}"#,
    r#"{"enabled":true,"historyMaxBytes":{"a":1}}"#,
    r#"{"enabled":true,"previousDocument":"yes"}"#,
    r#"{"enabled":false,"previousDocument":1}"#,
];

#[tokio::test(flavor = "multi_thread")]
async fn sync_and_change_settings_survive_hostile_bodies_and_a_restart() {
    let scratch = ScratchDirectory::new("settings-feeds");
    let rust_directory = scratch.path().join("rust");
    let rust = rust_durable(&rust_directory, NOTES, feed_options(false, false)).await;
    let reference_directory = scratch.path().join("reference");
    let reference =
        ReferenceServer::start(reference_spec(Some(&reference_directory), false, false)).await;
    seed_reference(&reference, NOTES).await;

    let sync = format!("/indexes/{INDEX}/sync");
    let changes = format!("/indexes/{INDEX}/changes");
    for path in [&sync, &changes] {
        same_status(rust.port, reference.port, path).await;
        for body in SETTING_BODIES {
            same_error(rust.port, reference.port, &put(path, body)).await;
        }
        for path in ["/indexes/ghost/sync", "/indexes/ghost/changes"] {
            same_error(rust.port, reference.port, &put(path, "null")).await;
            same_error(rust.port, reference.port, &put(path, r#"{"enabled":true}"#)).await;
            same_error(
                rust.port,
                reference.port,
                &Call::new("GET", path).authorized(),
            )
            .await;
        }
    }

    for (path, body) in [
        (
            &sync,
            r#"{"enabled":true,"historyMaxAgeMs":60000,"historyMaxBytes":1048576}"#,
        ),
        (
            &changes,
            r#"{"enabled":true,"previousDocument":true,"historyMaxAgeMs":120000}"#,
        ),
    ] {
        let (mine, _) = same_error(rust.port, reference.port, &put(path, body)).await;
        assert_eq!(mine.status, 200);
        assert_eq!(field(&mine.json(), "ok"), Some(&Value::Bool(true)));
    }
    let sync_status = same_status(rust.port, reference.port, &sync).await;
    let changes_status = same_status(rust.port, reference.port, &changes).await;
    assert_eq!(
        field(&sync_status, "historyMaxBytes"),
        Some(&Value::Number(1_048_576.0))
    );
    assert_eq!(
        field(&sync_status, "epoch"),
        field(&changes_status, "epoch"),
        "sync and change capture share the epoch of the index"
    );

    rust.stop().await;
    let engine = settings_support::durable_engine(&rust_directory);
    let rust = RustServer::start(engine, feed_options(false, false)).await;
    let read = Call::new("GET", &sync).authorized();
    assert_eq!(
        send(rust.port, &read).await.json(),
        sync_status,
        "the sync setting stays after a restart"
    );
    let read = Call::new("GET", &changes).authorized();
    assert_eq!(send(rust.port, &read).await.json(), changes_status);

    for (path, body) in [
        (&changes, r#"{"enabled":false}"#),
        (&sync, r#"{"enabled":false}"#),
    ] {
        let (mine, _) = same_error(rust.port, reference.port, &put(path, body)).await;
        assert_eq!(mine.status, 200);
    }
    same_status(rust.port, reference.port, &sync).await;
    same_status(rust.port, reference.port, &changes).await;
    reference.stop().await;
    rust.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_engine_without_a_log_refuses_sync_and_change_capture_as_typescript_does() {
    let engine = narsil::Narsil::new();
    seed(&engine, NOTES);
    let rust = RustServer::start(engine, feed_options(false, false)).await;
    let reference = ReferenceServer::start(reference_spec(None, false, false)).await;
    seed_reference(&reference, NOTES).await;
    for path in [
        format!("/indexes/{INDEX}/sync"),
        format!("/indexes/{INDEX}/changes"),
    ] {
        same_status(rust.port, reference.port, &path).await;
        same_error(
            rust.port,
            reference.port,
            &put(&path, r#"{"enabled":true}"#),
        )
        .await;
        same_error(
            rust.port,
            reference.port,
            &put(&path, r#"{"enabled":false}"#),
        )
        .await;
        same_error(rust.port, reference.port, &put(&path, r#"{"enabled":"x"}"#)).await;
    }
    reference.stop().await;
    rust.stop().await;
}
