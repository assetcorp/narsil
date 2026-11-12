use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use narsil::{
    AdapterError, DurabilityConfig, DurabilityTier, ErrorCode, IndexConfig, Map, MemoryPersistence,
    Narsil, NarsilConfig, PersistenceAdapter, Value, parse_json,
};

const SERVING: &str = "serving";
const CREATED: &str = "created";
const STALLED_SAVE_START: Duration = Duration::from_secs(30);
const STALLED_SAVE_RELEASE: Duration = Duration::from_secs(120);
const OTHER_INDEX_ANSWER: Duration = Duration::from_secs(10);
const SHUTDOWN_BESIDE_STALLED_SAVE: Duration = Duration::from_secs(2);

struct StallingPersistence {
    stored: Arc<MemoryPersistence>,
    reached: Mutex<Option<Sender<()>>>,
    release: Mutex<Receiver<()>>,
}

impl PersistenceAdapter for StallingPersistence {
    fn save(&self, key: &str, data: &[u8]) -> Result<(), AdapterError> {
        if key.starts_with(&format!("{CREATED}/")) {
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

struct StalledEngine {
    engine: Narsil,
    reached: Receiver<()>,
    release: Sender<()>,
}

fn durable_engine(persistence: Arc<dyn PersistenceAdapter>) -> Narsil {
    Narsil::open(NarsilConfig {
        durability: Some(DurabilityConfig {
            tier: Some(DurabilityTier::Snapshot),
            ..DurabilityConfig::default()
        }),
        persistence: Some(persistence),
        ..NarsilConfig::default()
    })
    .expect("the engine opens")
}

fn stalled_engine(stored: Arc<MemoryPersistence>) -> StalledEngine {
    let (reached, reached_receiver) = channel();
    let (release, release_receiver) = channel();
    let engine = durable_engine(Arc::new(StallingPersistence {
        stored,
        reached: Mutex::new(Some(reached)),
        release: Mutex::new(release_receiver),
    }));
    engine
        .create_index(SERVING, titled_index())
        .expect("the serving index is created");
    StalledEngine {
        engine,
        reached: reached_receiver,
        release,
    }
}

fn titled_index() -> IndexConfig {
    IndexConfig {
        schema: parse_json(r#"{"title": "string"}"#).expect("the schema is JSON"),
        ..IndexConfig::default()
    }
}

fn note(id: &str, title: &str) -> Map {
    let mut map = Map::new();
    map.insert("id", Value::String(id.to_string()));
    map.insert("title", Value::String(title.to_string()));
    map
}

fn index_names(engine: &Narsil) -> Vec<String> {
    engine
        .list_indexes()
        .into_iter()
        .map(|info| info.name)
        .collect()
}

fn asked<'scope, T: Send + 'scope>(
    scope: &'scope std::thread::Scope<'scope, '_>,
    call: impl FnOnce() -> T + Send + 'scope,
) -> Receiver<T> {
    let (answered, answer) = channel();
    scope.spawn(move || {
        let _ = answered.send(call());
    });
    answer
}

#[test]
fn calls_on_other_indexes_answer_while_a_create_waits_on_its_first_save() {
    let StalledEngine {
        engine,
        reached,
        release,
    } = stalled_engine(Arc::new(MemoryPersistence::new()));
    engine
        .insert(SERVING, note("kept", "written before the create"), None)
        .expect("the first note is inserted");

    std::thread::scope(|scope| {
        let first = scope.spawn(|| engine.create_index(CREATED, titled_index()));
        reached
            .recv_timeout(STALLED_SAVE_START)
            .expect("the create reaches its first save");
        let second = scope.spawn(|| engine.create_index(CREATED, titled_index()));

        let read = asked(scope, || engine.get(SERVING, "kept"));
        let written = asked(scope, || {
            engine.insert(SERVING, note("later", "written meanwhile"), None)
        });
        let listed = asked(scope, || engine.list_indexes().len());
        let read = read.recv_timeout(OTHER_INDEX_ANSWER).ok();
        let written = written.recv_timeout(OTHER_INDEX_ANSWER).ok();
        let listed = listed.recv_timeout(OTHER_INDEX_ANSWER).ok();
        let _ = release.send(());

        let read = read.expect("a read of another index answers while the save waits");
        assert!(read.expect("the read succeeds").is_some());
        let written = written.expect("a write to another index answers while the save waits");
        assert_eq!(written.expect("the write succeeds"), "later");
        assert_eq!(
            listed.expect("the index list answers while the save waits"),
            1,
            "the list holds only the serving index until the create finishes"
        );

        first
            .join()
            .expect("the first create returns")
            .expect("the first create succeeds");
        let refused = second
            .join()
            .expect("the second create returns")
            .expect_err("a second create of the same name is refused");
        assert_eq!(refused.code(), ErrorCode::INDEX_ALREADY_EXISTS);
    });

    assert_eq!(
        index_names(&engine),
        vec![CREATED.to_string(), SERVING.to_string()]
    );
    engine.shutdown().expect("the engine shuts down");
}

#[test]
fn every_concurrent_shutdown_waits_for_a_create_that_is_saving_and_the_created_index_reopens() {
    let stored = Arc::new(MemoryPersistence::new());
    let StalledEngine {
        engine,
        reached,
        release,
    } = stalled_engine(Arc::clone(&stored));

    std::thread::scope(|scope| {
        let created = scope.spawn(|| engine.create_index(CREATED, titled_index()));
        reached
            .recv_timeout(STALLED_SAVE_START)
            .expect("the create reaches its first save");
        let first_shutdown = asked(scope, || engine.shutdown());
        let second_shutdown = asked(scope, || engine.shutdown());
        let first_returned_during_save = first_shutdown
            .recv_timeout(SHUTDOWN_BESIDE_STALLED_SAVE)
            .is_ok();
        let second_returned_during_save = second_shutdown
            .recv_timeout(SHUTDOWN_BESIDE_STALLED_SAVE)
            .is_ok();
        let _ = release.send(());

        assert!(
            !first_returned_during_save && !second_returned_during_save,
            "every shutdown waits for the create that is saving"
        );
        created
            .join()
            .expect("the create returns")
            .expect("the create that began before the shutdown succeeds");
        for shut_down in [first_shutdown, second_shutdown] {
            shut_down
                .recv_timeout(OTHER_INDEX_ANSWER)
                .expect("the shutdown returns once the create finishes")
                .expect("the engine shuts down");
        }
    });

    let refused = engine
        .create_index("after", titled_index())
        .expect_err("a create after the shutdown is refused");
    assert_eq!(refused.code(), ErrorCode::INSTANCE_SHUT_DOWN);
    assert_eq!(
        index_names(&engine),
        Vec::<String>::new(),
        "the shut-down engine holds no index"
    );

    let reopened = durable_engine(stored);
    assert_eq!(
        index_names(&reopened),
        vec![CREATED.to_string(), SERVING.to_string()]
    );
    reopened.shutdown().expect("the reopened engine shuts down");
}
