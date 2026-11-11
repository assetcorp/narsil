use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use narsil::{
    AdapterError, DurabilityConfig, DurabilityTier, IndexConfig, Map, MemoryPersistence, Narsil,
    NarsilConfig, PersistenceAdapter, Value, parse_json,
};

const INDEX: &str = "notes";
const STALLED_SAVE_START: Duration = Duration::from_secs(30);
const STALLED_SAVE_RELEASE: Duration = Duration::from_secs(120);
const EVERY_CALL_RETURNS: Duration = Duration::from_secs(10);
const LISTING_POLL: Duration = Duration::from_millis(5);
const LISTING_POLLS: u32 = 2_000;

struct StallingSaves {
    stored: MemoryPersistence,
    armed: AtomicBool,
    reached: Mutex<Option<Sender<()>>>,
    release: Mutex<Receiver<()>>,
}

impl PersistenceAdapter for StallingSaves {
    fn save(&self, key: &str, data: &[u8]) -> Result<(), AdapterError> {
        if self.armed.load(Ordering::Acquire) && key.starts_with(&format!("{INDEX}/")) {
            let reached = self
                .reached
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
            if let Some(reached) = reached {
                let _ = reached.send(());
                let _ = self
                    .release
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .recv_timeout(STALLED_SAVE_RELEASE);
            }
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

fn answered<T: Send + 'static>(call: impl FnOnce() -> T + Send + 'static) -> Receiver<T> {
    let (answer, answers) = channel();
    thread::spawn(move || {
        let _ = answer.send(call());
    });
    answers
}

fn await_empty_listing(engine: &Narsil) {
    for _ in 0..LISTING_POLLS {
        if engine.list_indexes().is_empty() {
            return;
        }
        thread::sleep(LISTING_POLL);
    }
    panic!("the shutdown never took the index out of the listing");
}

#[test]
fn a_close_that_finishes_during_a_shutdown_leaves_no_index_in_the_listing() {
    let (reached, save_started) = channel();
    let (release, release_receiver) = channel();
    let persistence = Arc::new(StallingSaves {
        stored: MemoryPersistence::new(),
        armed: AtomicBool::new(false),
        reached: Mutex::new(Some(reached)),
        release: Mutex::new(release_receiver),
    });
    let engine = Arc::new(
        Narsil::open(NarsilConfig {
            durability: Some(DurabilityConfig {
                tier: Some(DurabilityTier::Snapshot),
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
    let mut note = Map::new();
    note.insert("id", Value::String("kept".to_string()));
    note.insert(
        "title",
        Value::String("written before the close".to_string()),
    );
    engine
        .insert(INDEX, note, None)
        .expect("the note is inserted");
    persistence.armed.store(true, Ordering::Release);

    let closing = Arc::clone(&engine);
    let closed = answered(move || closing.close_index(INDEX));
    save_started
        .recv_timeout(STALLED_SAVE_START)
        .expect("the close saves the index's checkpoint");
    let stopping = Arc::clone(&engine);
    let stopped = answered(move || stopping.shutdown());
    await_empty_listing(&engine);
    let _ = release.send(());

    stopped
        .recv_timeout(EVERY_CALL_RETURNS)
        .expect("the shutdown returns")
        .expect("the engine shuts down");
    closed
        .recv_timeout(EVERY_CALL_RETURNS)
        .expect("the close returns")
        .expect("the close that began before the shutdown finishes");
    assert!(
        engine.list_indexes().is_empty(),
        "the shut-down engine lists no index"
    );
}
