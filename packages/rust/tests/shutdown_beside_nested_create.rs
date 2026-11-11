use std::cell::RefCell;
use std::io::{self, Read};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex, Weak};
use std::thread;
use std::time::Duration;

use narsil::{
    AdapterError, DurabilityConfig, DurabilityTier, ErrorCode, IndexConfig, Map, MemoryPersistence,
    Narsil, NarsilConfig, PersistenceAdapter, Value, parse_json,
};

const OUTER: &str = "outer";
const INNER: &str = "inner";
const WARMUP: &str = "warmup";
const NEVER_CREATED: &str = "never-created";
const STALL_START: Duration = Duration::from_secs(30);
const STALL_RELEASE: Duration = Duration::from_secs(120);
const SETTLE: Duration = Duration::from_millis(200);
const SHUTDOWN_FLAG_POLL: Duration = Duration::from_millis(5);
const SHUTDOWN_FLAG_POLLS: u32 = 2_000;
const EVERY_CALL_RETURNS: Duration = Duration::from_secs(10);
const REFUSED_AT_THE_CLOSED_GATE: &str =
    "This Narsil instance shut down before the index could join it";

type CallInsideSave = fn(&Narsil) -> narsil::Result<()>;

struct NestingPersistence {
    stored: MemoryPersistence,
    engine: Mutex<Weak<Narsil>>,
    call_inside_save: CallInsideSave,
    nesting: Mutex<Option<Sender<()>>>,
    nested: Mutex<Option<Sender<narsil::Result<()>>>>,
}

fn create_inner(engine: &Narsil) -> narsil::Result<()> {
    engine.create_index(INNER, titled_index()).map(|_| ())
}

fn shut_down(engine: &Narsil) -> narsil::Result<()> {
    engine.shutdown()
}

struct NestingEngine {
    engine: Arc<Narsil>,
    nesting_started: Receiver<()>,
    nested_result: Receiver<narsil::Result<()>>,
}

fn nesting_engine(call_inside_save: CallInsideSave) -> NestingEngine {
    let (nesting, nesting_started) = channel();
    let (nested, nested_result) = channel();
    let adapter = Arc::new(NestingPersistence {
        stored: MemoryPersistence::new(),
        engine: Mutex::new(Weak::new()),
        call_inside_save,
        nesting: Mutex::new(Some(nesting)),
        nested: Mutex::new(Some(nested)),
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
    NestingEngine {
        engine,
        nesting_started,
        nested_result,
    }
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl PersistenceAdapter for NestingPersistence {
    fn save(&self, key: &str, data: &[u8]) -> Result<(), AdapterError> {
        if key.starts_with(&format!("{OUTER}/"))
            && let Some(nesting) = locked(&self.nesting).take()
        {
            let _ = nesting.send(());
            let engine = locked(&self.engine).upgrade();
            let nested = match engine {
                Some(engine) => (self.call_inside_save)(&engine),
                None => Ok(()),
            };
            if let Some(report) = locked(&self.nested).take() {
                let _ = report.send(nested);
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

struct StallingArchive {
    bytes: Vec<u8>,
    at: usize,
    reached: Option<Sender<()>>,
    release: Receiver<()>,
}

impl Read for StallingArchive {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if let Some(reached) = self.reached.take() {
            let _ = reached.send(());
            let _ = self.release.recv_timeout(STALL_RELEASE);
        }
        let count = buffer.len().min(self.bytes.len() - self.at);
        buffer[..count].copy_from_slice(&self.bytes[self.at..self.at + count]);
        self.at += count;
        Ok(count)
    }
}

fn titled_index() -> IndexConfig {
    IndexConfig {
        schema: parse_json(r#"{"title": "string"}"#).expect("the schema is JSON"),
        ..IndexConfig::default()
    }
}

fn archive_of_one_note() -> Vec<u8> {
    let source = Narsil::new();
    source
        .create_index(INNER, titled_index())
        .expect("the source index is created");
    let mut note = Map::new();
    note.insert("id", Value::String("archived".to_string()));
    note.insert(
        "title",
        Value::String("held only by the archive".to_string()),
    );
    source
        .insert(INNER, note, None)
        .expect("the archived note is inserted");
    let mut archive = Vec::new();
    source
        .snapshot(INNER, &mut archive)
        .expect("the snapshot is written");
    archive
}

fn answered<T: Send + 'static>(call: impl FnOnce() -> T + Send + 'static) -> Receiver<T> {
    let (answer, answers) = channel();
    thread::spawn(move || {
        let _ = answer.send(call());
    });
    answers
}

fn await_shutdown_flag(engine: &Narsil) {
    for _ in 0..SHUTDOWN_FLAG_POLLS {
        let probe = engine.drop_index(NEVER_CREATED);
        if probe.is_err_and(|error| error.code() == ErrorCode::INSTANCE_SHUT_DOWN) {
            return;
        }
        thread::sleep(SHUTDOWN_FLAG_POLL);
    }
    panic!("the shutdown never set its flag");
}

#[test]
fn a_create_nested_in_a_save_while_a_shutdown_waits_is_refused_and_every_call_returns() {
    let NestingEngine {
        engine,
        nesting_started,
        nested_result,
    } = nesting_engine(create_inner);

    let (reached, restore_holds_name) = channel();
    let (release, release_receiver) = channel();
    let mut archive = StallingArchive {
        bytes: archive_of_one_note(),
        at: 0,
        reached: Some(reached),
        release: release_receiver,
    };
    let restoring = Arc::clone(&engine);
    let restored = answered(move || restoring.restore(INNER, &mut archive));
    restore_holds_name
        .recv_timeout(STALL_START)
        .expect("the restore holds the inner name");

    let creating = Arc::clone(&engine);
    let created = answered(move || creating.create_index(OUTER, titled_index()).map(|_| ()));
    nesting_started
        .recv_timeout(STALL_START)
        .expect("the outer create's save starts the nested create");
    thread::sleep(SETTLE);

    let stopping = Arc::clone(&engine);
    let stopped = answered(move || stopping.shutdown());
    await_shutdown_flag(&engine);
    thread::sleep(SETTLE);
    let _ = release.send(());

    let stopped = stopped
        .recv_timeout(EVERY_CALL_RETURNS)
        .expect("the shutdown returns");
    let created = created
        .recv_timeout(EVERY_CALL_RETURNS)
        .expect("the outer create returns");
    let nested = nested_result
        .recv_timeout(EVERY_CALL_RETURNS)
        .expect("the nested create returns");
    let restored = restored
        .recv_timeout(EVERY_CALL_RETURNS)
        .expect("the restore returns");

    stopped.expect("the engine shuts down");
    created.expect("the outer create that began before the shutdown succeeds");
    let nested = nested.expect_err("the nested create is refused");
    assert_eq!(nested.code(), ErrorCode::INSTANCE_SHUT_DOWN);
    assert_eq!(
        nested.message(),
        REFUSED_AT_THE_CLOSED_GATE,
        "the nested create asks to join the engine while the shutdown waits for the outer create that runs it"
    );
    assert_eq!(
        restored.expect_err("the restore is refused").code(),
        ErrorCode::INSTANCE_SHUT_DOWN
    );
    assert!(engine.list_indexes().is_empty());
}

#[test]
fn a_shutdown_called_from_a_save_of_the_create_is_refused_and_the_engine_keeps_working() {
    let NestingEngine {
        engine,
        nesting_started,
        nested_result,
    } = nesting_engine(shut_down);

    let creating = Arc::clone(&engine);
    let created = answered(move || creating.create_index(OUTER, titled_index()).map(|_| ()));
    nesting_started
        .recv_timeout(STALL_START)
        .expect("the outer create's save calls shutdown");
    let created = created
        .recv_timeout(EVERY_CALL_RETURNS)
        .expect("the outer create returns");
    let nested = nested_result
        .recv_timeout(EVERY_CALL_RETURNS)
        .expect("the shutdown inside the save returns");

    assert_eq!(
        nested
            .expect_err("the shutdown inside the save is refused")
            .code(),
        ErrorCode::CONFIG_INVALID
    );
    created.expect("the outer create succeeds");
    let mut note = Map::new();
    note.insert("id", Value::String("kept".to_string()));
    note.insert(
        "title",
        Value::String("written after the refusal".to_string()),
    );
    engine
        .insert(OUTER, note, None)
        .expect("the engine takes a write after the refusal");
    assert!(
        engine
            .get(OUTER, "kept")
            .expect("the read answers")
            .is_some()
    );

    let stopping = Arc::clone(&engine);
    answered(move || stopping.shutdown())
        .recv_timeout(EVERY_CALL_RETURNS)
        .expect("a later shutdown returns")
        .expect("a later shutdown succeeds");
    assert_eq!(
        engine
            .create_index(INNER, titled_index())
            .expect_err("a create after the shutdown is refused")
            .code(),
        ErrorCode::INSTANCE_SHUT_DOWN
    );
}

struct CreatesOnThreadExit {
    engine: Arc<Narsil>,
    created: Sender<narsil::Result<()>>,
}

impl Drop for CreatesOnThreadExit {
    fn drop(&mut self) {
        let created = self.engine.create_index(OUTER, titled_index()).map(|_| ());
        let _ = self.created.send(created);
    }
}

thread_local! {
    static CREATE_ON_THREAD_EXIT: RefCell<Option<CreatesOnThreadExit>> = const { RefCell::new(None) };
}

#[test]
fn a_shutdown_called_from_a_save_of_a_create_made_while_its_thread_exits_is_refused() {
    let NestingEngine {
        engine,
        nesting_started: _,
        nested_result,
    } = nesting_engine(shut_down);
    let (created, created_result) = channel();
    let exiting = Arc::clone(&engine);
    thread::spawn(move || {
        CREATE_ON_THREAD_EXIT.with(|slot| {
            *slot.borrow_mut() = Some(CreatesOnThreadExit {
                engine: Arc::clone(&exiting),
                created,
            });
        });
        exiting
            .create_index(WARMUP, titled_index())
            .expect("the warmup index is created");
    });

    let nested = nested_result
        .recv_timeout(EVERY_CALL_RETURNS)
        .expect("the shutdown inside the save returns");
    assert_eq!(
        nested
            .expect_err("the shutdown inside the save is refused")
            .code(),
        ErrorCode::CONFIG_INVALID
    );
    created_result
        .recv_timeout(EVERY_CALL_RETURNS)
        .expect("the create made while the thread exits returns")
        .expect("the create made while the thread exits succeeds");
    assert_eq!(engine.list_indexes().len(), 2);
}
