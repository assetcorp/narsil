use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use narsil::{
    AdapterError, DurabilityConfig, DurabilityTier, ErrorCode, IndexConfig, Map, MemoryPersistence,
    Narsil, NarsilConfig, PersistenceAdapter, Value, parse_json,
};

const INDEX: &str = "notes";
const STALLED_LOAD_START: Duration = Duration::from_secs(30);
const STALLED_LOAD_RELEASE: Duration = Duration::from_secs(120);
const SHUTDOWN_ANSWER: Duration = Duration::from_secs(10);

struct StallingLoads {
    stored: MemoryPersistence,
    armed: AtomicBool,
    reached: Mutex<Option<Sender<()>>>,
    release: Mutex<Receiver<()>>,
}

impl PersistenceAdapter for StallingLoads {
    fn save(&self, key: &str, data: &[u8]) -> Result<(), AdapterError> {
        self.stored.save(key, data)
    }

    fn load(&self, key: &str) -> Result<Option<Vec<u8>>, AdapterError> {
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
                    .recv_timeout(STALLED_LOAD_RELEASE);
            }
        }
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

fn answered<'scope, T: Send + 'scope>(
    scope: &'scope std::thread::Scope<'scope, '_>,
    call: impl FnOnce() -> T + Send + 'scope,
) -> Receiver<T> {
    let (answer, answers) = channel();
    scope.spawn(move || {
        let _ = answer.send(call());
    });
    answers
}

#[test]
fn a_reopen_that_a_shutdown_overtakes_is_refused_and_leaves_no_index_in_the_engine() {
    let (reached, reached_receiver) = channel();
    let (release, release_receiver) = channel();
    let persistence = Arc::new(StallingLoads {
        stored: MemoryPersistence::new(),
        armed: AtomicBool::new(false),
        reached: Mutex::new(Some(reached)),
        release: Mutex::new(release_receiver),
    });
    let engine = Narsil::open(NarsilConfig {
        durability: Some(DurabilityConfig {
            tier: Some(DurabilityTier::Snapshot),
            ..DurabilityConfig::default()
        }),
        persistence: Some(Arc::clone(&persistence) as Arc<dyn PersistenceAdapter>),
        ..NarsilConfig::default()
    })
    .expect("the engine opens");
    engine
        .create_index(
            INDEX,
            IndexConfig {
                schema: parse_json(r#"{"title": "string"}"#).expect("the schema is JSON"),
                ..IndexConfig::default()
            },
        )
        .expect("the index is created");
    engine
        .insert(INDEX, note("kept", "written before the close"), None)
        .expect("the note is inserted");
    engine.close_index(INDEX).expect("the index closes");
    persistence.armed.store(true, Ordering::Release);

    std::thread::scope(|scope| {
        let reopen = answered(scope, || engine.open_index(INDEX));
        reached_receiver
            .recv_timeout(STALLED_LOAD_START)
            .expect("the reopen loads the index's files");
        let shutdown = answered(scope, || engine.shutdown());
        let shut_down = shutdown.recv_timeout(SHUTDOWN_ANSWER).ok();
        let _ = release.send(());

        shut_down
            .expect("the shutdown returns while the reopen waits on its load")
            .expect("the engine shuts down");
        let refused = reopen
            .recv_timeout(STALLED_LOAD_RELEASE)
            .expect("the reopen returns")
            .expect_err("a reopen that the shutdown overtook is refused");
        assert_eq!(refused.code(), ErrorCode::INSTANCE_SHUT_DOWN);
    });

    assert!(
        engine.list_indexes().is_empty(),
        "the shut-down engine holds no index"
    );
}
