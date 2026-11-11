mod support;

use std::path::Path;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use narsil::{
    AdapterError, AdapterSetting, DurabilityConfig, EmbeddingConfig, ErrorCode, IndexConfig, Map,
    Narsil, NarsilConfig, Value, parse_json,
};
use support::ScratchDirectory;
use support::adapters::EmbedWith;

const INDEX: &str = "notes";
const EMBEDDING_ADAPTER: &str = "titles";
const DIMENSIONS: usize = 3;
const HELD_WRITE_START: Duration = Duration::from_secs(30);
const HELD_WRITE_RELEASE: Duration = Duration::from_secs(120);

type Embedded = Result<Vec<f32>, AdapterError>;

fn log_tier(root: &Path) -> NarsilConfig {
    NarsilConfig {
        durability: Some(DurabilityConfig {
            directory: Some(root.to_path_buf()),
            ..DurabilityConfig::default()
        }),
        ..NarsilConfig::default()
    }
}

fn title_vector(title: &str) -> Vec<f32> {
    vec![title.len() as f32, 1.0, 0.5]
}

fn held_embedding(
    entered: Sender<()>,
    release: Receiver<()>,
) -> EmbedWith<impl Fn(&str) -> Embedded + Send + Sync> {
    let entered = Mutex::new(entered);
    let release = Mutex::new(release);
    EmbedWith {
        dimensions: DIMENSIONS,
        embed: move |title: &str| {
            if let Ok(entered) = entered.lock() {
                let _ = entered.send(());
            }
            if let Ok(release) = release.lock() {
                let _ = release.recv_timeout(HELD_WRITE_RELEASE);
            }
            Ok(title_vector(title))
        },
    }
}

fn prompt_embedding() -> EmbedWith<impl Fn(&str) -> Embedded + Send + Sync> {
    EmbedWith {
        dimensions: DIMENSIONS,
        embed: |title: &str| Ok(title_vector(title)),
    }
}

fn note(id: &str, title: &str) -> Map {
    let mut map = Map::new();
    map.insert("id", Value::String(id.to_string()));
    map.insert("title", Value::String(title.to_string()));
    map
}

fn embedded_index() -> IndexConfig {
    IndexConfig {
        schema: parse_json(r#"{"title": "string", "embedding": "vector[3]"}"#)
            .expect("the schema is JSON"),
        embedding: Some(EmbeddingConfig {
            fields: vec![("embedding".to_string(), vec!["title".to_string()])],
            adapter: Some(AdapterSetting::Named(EMBEDDING_ADAPTER.to_string())),
        }),
        ..IndexConfig::default()
    }
}

fn opened_with_prompt_embedding(root: &Path) -> Narsil {
    Narsil::open_with(log_tier(root), |engine| {
        engine.register_embedding_adapter(EMBEDDING_ADAPTER, Arc::new(prompt_embedding()))
    })
    .expect("the directory opens once the earlier engine has shut down")
}

#[test]
fn a_write_held_in_its_embedding_call_writes_nothing_after_the_engine_shuts_down() {
    let root = ScratchDirectory::new("shutdown-beside-held-write");
    let (entered_sender, entered) = channel();
    let (release, release_receiver) = channel();
    let stopped = Narsil::open_with(log_tier(root.path()), |engine| {
        engine.register_embedding_adapter(
            EMBEDDING_ADAPTER,
            Arc::new(held_embedding(entered_sender, release_receiver)),
        )
    })
    .expect("the first engine opens");
    stopped
        .create_index(INDEX, embedded_index())
        .expect("the index is created");

    std::thread::scope(|scope| {
        let held = scope.spawn(|| {
            stopped.insert(
                INDEX,
                note("late", "written after the engine stopped"),
                None,
            )
        });
        entered
            .recv_timeout(HELD_WRITE_START)
            .expect("the held write reaches its embedding adapter");
        stopped.shutdown().expect("the first engine shuts down");

        let successor = opened_with_prompt_embedding(root.path());
        let _ = release.send(());
        let refused = held
            .join()
            .expect("the held write returns")
            .expect_err("a write that the shutdown overtook is refused");
        assert_eq!(refused.code(), ErrorCode::INSTANCE_SHUT_DOWN);

        assert_eq!(
            successor.get(INDEX, "late").expect("the read answers"),
            None,
            "the next engine holds no document of the stopped engine's refused write"
        );
        successor
            .insert(INDEX, note("kept", "written by the next engine"), None)
            .expect("the next engine writes to the directory that it owns");
        successor.shutdown().expect("the next engine shuts down");
    });

    let recovered = opened_with_prompt_embedding(root.path());
    assert_eq!(
        recovered.get(INDEX, "late").expect("the read answers"),
        None,
        "recovery replays no record of the refused write"
    );
    let kept = recovered
        .get(INDEX, "kept")
        .expect("the read answers")
        .expect("recovery holds the document that the next engine wrote");
    assert_eq!(
        kept.get("title"),
        Some(&Value::String("written by the next engine".to_string()))
    );
    recovered.shutdown().expect("the last engine shuts down");
}
