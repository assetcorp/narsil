use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use narsil::{
    AdapterError, DurabilityConfig, DurabilityTier, IndexConfig, Map, MemoryPersistence, Narsil,
    NarsilConfig, NarsilEventKind, PersistenceAdapter, Value, parse_json,
};

const INDEX: &str = "notes";
const LISTENER_START: Duration = Duration::from_secs(30);
const SHUTDOWN_UNDER_WAY: Duration = Duration::from_secs(30);
const SHUTDOWN_POLL: Duration = Duration::from_millis(10);
const SHUTDOWN_ANSWER: Duration = Duration::from_secs(10);
const LISTENER_RELEASE: Duration = Duration::from_secs(120);

struct FailingSaves {
    stored: MemoryPersistence,
    failing: AtomicBool,
}

impl PersistenceAdapter for FailingSaves {
    fn save(&self, key: &str, data: &[u8]) -> Result<(), AdapterError> {
        if self.failing.load(Ordering::Acquire) {
            return Err(AdapterError::from("the disk refuses every write"));
        }
        self.stored.save(key, data)
    }

    fn load(&self, key: &str) -> Result<Option<Vec<u8>>, AdapterError> {
        self.stored.load(key)
    }

    fn delete(&self, key: &str) -> Result<(), AdapterError> {
        self.stored.delete(key)
    }

    fn list(&self, prefix: &str) -> Result<Vec<String>, AdapterError> {
        self.stored.list(prefix)
    }
}

fn note(id: &str, title: &str) -> Map {
    let mut map = Map::new();
    map.insert("id", Value::String(id.to_string()));
    map.insert("title", Value::String(title.to_string()));
    map
}

fn shutdown_on_another_thread(engine: &Arc<Narsil>) -> Receiver<narsil::Result<()>> {
    let engine = Arc::clone(engine);
    let (answer, answers) = channel();
    std::thread::spawn(move || {
        let _ = answer.send(engine.shutdown());
    });
    answers
}

#[test]
fn a_listener_on_the_checkpoint_thread_that_shuts_down_beside_another_shutdown_lets_both_return() {
    let persistence = Arc::new(FailingSaves {
        stored: MemoryPersistence::new(),
        failing: AtomicBool::new(false),
    });
    let engine = Arc::new(
        Narsil::open(NarsilConfig {
            durability: Some(DurabilityConfig {
                tier: Some(DurabilityTier::Snapshot),
                checkpoint_interval_ms: Some(0),
                checkpoint_mutation_threshold: Some(1),
                ..DurabilityConfig::default()
            }),
            persistence: Some(Arc::clone(&persistence) as Arc<dyn PersistenceAdapter>),
            ..NarsilConfig::default()
        })
        .expect("the engine opens"),
    );
    engine
        .create_index(
            INDEX,
            IndexConfig {
                schema: parse_json(r#"{"title": "string"}"#).expect("the schema is JSON"),
                ..IndexConfig::default()
            },
        )
        .expect("the index is created");

    let (entered, entered_receiver) = channel();
    let (release, release_receiver) = channel::<()>();
    let (listener_answer, listener_answers) = channel();
    let release_receiver = Mutex::new(release_receiver);
    let listener_engine = Arc::downgrade(&engine);
    engine.on(NarsilEventKind::DurabilityError, move |_| {
        let _ = entered.send(());
        let released = release_receiver
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .recv_timeout(LISTENER_RELEASE);
        if released.is_err() {
            return;
        }
        if let Some(engine) = listener_engine.upgrade() {
            let _ = listener_answer.send(engine.shutdown());
        }
    });
    persistence.failing.store(true, Ordering::Release);
    engine
        .insert(
            INDEX,
            note("unsaved", "a write that the checkpoint fails to save"),
            None,
        )
        .expect("the note is inserted");
    entered_receiver
        .recv_timeout(LISTENER_START)
        .expect("the checkpoint thread raises the durability error");

    let external = shutdown_on_another_thread(&engine);
    let deadline = Instant::now() + SHUTDOWN_UNDER_WAY;
    while !engine.list_indexes().is_empty() && Instant::now() < deadline {
        std::thread::sleep(SHUTDOWN_POLL);
    }
    assert!(
        engine.list_indexes().is_empty(),
        "the external shutdown takes the indexes"
    );
    release
        .send(())
        .expect("the listener waits for its release");

    let listener_shutdown = listener_answers.recv_timeout(SHUTDOWN_ANSWER);
    let external_shutdown = external.recv_timeout(SHUTDOWN_ANSWER);
    assert!(
        listener_shutdown.is_ok(),
        "the listener's shutdown returns while the other shutdown waits for its thread"
    );
    assert!(
        external_shutdown.is_ok(),
        "the external shutdown returns once the listener finishes"
    );
}
