mod support;

use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use narsil::{
    AdapterSetting, EmbeddingConfig, IndexConfig, Map, Narsil, QueryParams, Storage, Value,
    VectorQuery, parse_json,
};
use support::ScratchDirectory;
use support::adapters::EmbedWith;
use support::portable::{Tier, snapshot_of};

const INDEX: &str = "documents";
const CHILD_DIRECTORY: &str = "NARSIL_RESTORE_EMBEDDING_CALLBACK_DIRECTORY";
const DEADLINE: Duration = Duration::from_secs(10);
const POLL_INTERVAL: Duration = Duration::from_millis(10);
const CALLBACK_ENTERED: &str = "The replacement adapter is restoring the index";

fn config(adapter: &str) -> IndexConfig {
    IndexConfig {
        schema: parse_json(r#"{"title":"string","embedding":"vector[2]"}"#).unwrap(),
        text_storage: Some(Storage::Disk),
        embedding: Some(EmbeddingConfig {
            fields: vec![("embedding".into(), vec!["title".into()])],
            adapter: Some(AdapterSetting::Named(adapter.into())),
        }),
        ..IndexConfig::default()
    }
}

fn insert(engine: &Narsil, id: &str, vector: [f64; 2]) {
    let mut document = Map::new();
    document.insert("title", Value::String(id.into()));
    document.insert(
        "embedding",
        Value::Array(vector.into_iter().map(Value::Number).collect()),
    );
    engine.insert(INDEX, document, Some(id)).unwrap();
}

fn search_with_restoring_adapters(root: &Path, preflight: bool) {
    let source = Tier::Log.open(&root.join("source"));
    source
        .register_embedding_adapter(
            "replacement",
            Arc::new(EmbedWith {
                dimensions: 2,
                embed: |_: &str| Ok(vec![0.0, 1.0]),
            }),
        )
        .unwrap();
    source.create_index(INDEX, config("replacement")).unwrap();
    insert(&source, "wanted", [0.0, 1.0]);
    insert(&source, "decoy", [1.0, 0.0]);
    let archive = Arc::new(snapshot_of(&source, INDEX));
    source.shutdown().unwrap();

    let target = Arc::new(Tier::Log.open(&root.join("target")));
    let replacement_target = Arc::downgrade(&target);
    let replacement_archive = Arc::clone(&archive);
    let restore_once = AtomicBool::new(true);
    target
        .register_embedding_adapter(
            "replacement",
            Arc::new(EmbedWith {
                dimensions: 2,
                embed: move |_: &str| {
                    if restore_once.swap(false, Ordering::SeqCst) {
                        eprintln!("{CALLBACK_ENTERED}");
                        replacement_target
                            .upgrade()
                            .unwrap()
                            .restore(INDEX, &mut replacement_archive.as_slice())?;
                    }
                    Ok(vec![0.0, 1.0])
                },
            }),
        )
        .unwrap();
    let original_target = Arc::downgrade(&target);
    target
        .register_embedding_adapter(
            "original",
            Arc::new(EmbedWith {
                dimensions: 2,
                embed: move |_: &str| {
                    original_target
                        .upgrade()
                        .unwrap()
                        .restore(INDEX, &mut archive.as_slice())?;
                    Ok(vec![1.0, 0.0])
                },
            }),
        )
        .unwrap();
    target.create_index(INDEX, config("original")).unwrap();
    insert(&target, "original", [1.0, 0.0]);
    target.checkpoint(INDEX).unwrap();

    let params = QueryParams {
        vector: Some(VectorQuery {
            field: "embedding".into(),
            text: Some("search".into()),
            similarity: Some(0.9),
            ..VectorQuery::default()
        }),
        ..QueryParams::default()
    };
    if preflight {
        assert_eq!(target.preflight(INDEX, &params).unwrap().count, 1);
    } else {
        let answer = target.query(INDEX, &params).unwrap();
        let ids: Vec<_> = answer.hits.iter().map(|hit| hit.id.as_str()).collect();
        assert_eq!(ids, vec!["wanted"]);
    }
    assert!(target.get(INDEX, "wanted").unwrap().is_some());
    target.shutdown().unwrap();
}

fn require_callback_finishes(test: &str, preflight: bool) {
    if let Some(root) = std::env::var_os(CHILD_DIRECTORY) {
        search_with_restoring_adapters(Path::new(&root), preflight);
        return;
    }
    let root = ScratchDirectory::new(test);
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test, "--nocapture", "--test-threads=1"])
        .env(CHILD_DIRECTORY, root.path())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let started = Instant::now();
    let mut timed_out = false;
    while child.try_wait().unwrap().is_none() {
        if started.elapsed() >= DEADLINE {
            timed_out = true;
            child.kill().unwrap();
            break;
        }
        std::thread::sleep(POLL_INTERVAL);
    }
    let output = child.wait_with_output().unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stderr.contains(CALLBACK_ENTERED),
        "the replacement adapter must reach its restore callback: {stdout}\n{stderr}"
    );
    assert!(
        !timed_out,
        "the second embedding deadlocked while its adapter restored the index: {stderr}"
    );
    assert!(output.status.success(), "{stdout}\n{stderr}");
}

#[test]
fn a_query_allows_a_replacement_embedding_adapter_to_restore_the_index() {
    require_callback_finishes(
        "a_query_allows_a_replacement_embedding_adapter_to_restore_the_index",
        false,
    );
}

#[test]
fn a_preflight_allows_a_replacement_embedding_adapter_to_restore_the_index() {
    require_callback_finishes(
        "a_preflight_allows_a_replacement_embedding_adapter_to_restore_the_index",
        true,
    );
}
