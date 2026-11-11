use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::thread;
use std::time::Duration;

use narsil::{
    AdapterError, DurabilityConfig, DurabilityTier, ErrorCode, IndexConfig, Map, MemoryPersistence,
    Narsil, NarsilConfig, PersistenceAdapter, Value, parse_json,
};

const INDEX: &str = "notes";
const EVERY_CALL_RETURNS: Duration = Duration::from_secs(10);

struct ShutsDownInsideCalls {
    stored: MemoryPersistence,
    engine: Mutex<Weak<Narsil>>,
    armed: AtomicBool,
    answer: Mutex<Option<Sender<narsil::Result<()>>>>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl ShutsDownInsideCalls {
    fn shut_down_once(&self, key: &str) {
        if !self.armed.load(Ordering::Acquire) || !key.starts_with(&format!("{INDEX}/")) {
            return;
        }
        let Some(answer) = locked(&self.answer).take() else {
            return;
        };
        let engine = locked(&self.engine).upgrade();
        if let Some(engine) = engine {
            let _ = answer.send(engine.shutdown());
        }
    }
}

impl PersistenceAdapter for ShutsDownInsideCalls {
    fn save(&self, key: &str, data: &[u8]) -> Result<(), AdapterError> {
        self.shut_down_once(key);
        self.stored.save(key, data)
    }

    fn load(&self, key: &str) -> Result<Option<Vec<u8>>, AdapterError> {
        self.stored.load(key)
    }

    fn delete(&self, key: &str) -> Result<(), AdapterError> {
        self.shut_down_once(key);
        self.stored.delete(key)
    }

    fn list(&self, prefix: &str) -> Result<Vec<String>, AdapterError> {
        self.stored.list(prefix)
    }
}

struct ArmedEngine {
    engine: Arc<Narsil>,
    adapter: Arc<ShutsDownInsideCalls>,
    shutdown_inside: Receiver<narsil::Result<()>>,
}

fn engine_with_one_note() -> ArmedEngine {
    let (answer, shutdown_inside) = channel();
    let adapter = Arc::new(ShutsDownInsideCalls {
        stored: MemoryPersistence::new(),
        engine: Mutex::new(Weak::new()),
        armed: AtomicBool::new(false),
        answer: Mutex::new(Some(answer)),
    });
    let engine = Arc::new(
        Narsil::open(NarsilConfig {
            durability: Some(DurabilityConfig {
                tier: Some(DurabilityTier::Snapshot),
                ..DurabilityConfig::default()
            }),
            persistence: Some(Arc::clone(&adapter) as Arc<dyn PersistenceAdapter>),
            ..NarsilConfig::default()
        })
        .expect("the engine opens"),
    );
    *locked(&adapter.engine) = Arc::downgrade(&engine);
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
        Value::String("written before the call".to_string()),
    );
    engine
        .insert(INDEX, note, None)
        .expect("the note is inserted");
    adapter.armed.store(true, Ordering::Release);
    ArmedEngine {
        engine,
        adapter,
        shutdown_inside,
    }
}

fn answered<T: Send + 'static>(call: impl FnOnce() -> T + Send + 'static) -> Receiver<T> {
    let (answer, answers) = channel();
    thread::spawn(move || {
        let _ = answer.send(call());
    });
    answers
}

fn assert_refused_and_shut_down_later(armed: &ArmedEngine) {
    let refused = armed
        .shutdown_inside
        .recv_timeout(EVERY_CALL_RETURNS)
        .expect("the shutdown inside the adapter returns")
        .expect_err("the shutdown inside the adapter is refused");
    assert_eq!(refused.code(), ErrorCode::CONFIG_INVALID);
    armed.adapter.armed.store(false, Ordering::Release);
    let stopping = Arc::clone(&armed.engine);
    answered(move || stopping.shutdown())
        .recv_timeout(EVERY_CALL_RETURNS)
        .expect("a later shutdown returns")
        .expect("a later shutdown succeeds");
}

#[test]
fn a_shutdown_called_from_the_save_of_a_close_is_refused_and_the_index_reopens() {
    let armed = engine_with_one_note();
    let closing = Arc::clone(&armed.engine);
    armed_call_returns(answered(move || closing.close_index(INDEX)), "the close");
    let note = armed
        .engine
        .get(INDEX, "kept")
        .expect("the closed index reopens for a read");
    assert!(note.is_some(), "the note written before the close is kept");
    assert_refused_and_shut_down_later(&armed);
}

#[test]
fn a_shutdown_called_from_the_delete_of_a_drop_is_refused_and_the_index_is_gone() {
    let armed = engine_with_one_note();
    let dropping = Arc::clone(&armed.engine);
    armed_call_returns(answered(move || dropping.drop_index(INDEX)), "the drop");
    assert!(armed.engine.list_indexes().is_empty());
    assert_refused_and_shut_down_later(&armed);
}

fn armed_call_returns(call: Receiver<narsil::Result<()>>, what: &str) {
    call.recv_timeout(EVERY_CALL_RETURNS)
        .unwrap_or_else(|_| panic!("{what} returns"))
        .unwrap_or_else(|error| panic!("{what} succeeds: {error}"));
}
