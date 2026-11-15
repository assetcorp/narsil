use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use narsil::{PersistenceAdapter, parse_plain_json, write_plain_json};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use tokio::sync::{OnceCell, mpsc, oneshot};

use super::store::{StoreFuture, TaskRecord, TaskStore};
use crate::constants::{DEFAULT_MAX_RETAINED_TASKS, TASK_RECORD_LOAD_CONCURRENCY};
use crate::options::BoxError;

const RECORD_KEY_SUFFIX: &str = ".json";
const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

type Done = oneshot::Sender<Result<(), BoxError>>;

enum KeyWrite {
    Save(String, Vec<u8>, Option<Done>),
    Delete(String, Option<Done>),
    Flush(Done),
}

enum LoadedKey {
    Record(Box<TaskRecord>),
    Unreadable,
    Malformed(String),
}

fn key_of(id: &str) -> String {
    format!(
        "{}{RECORD_KEY_SUFFIX}",
        utf8_percent_encode(id, URI_COMPONENT)
    )
}

fn id_of_key(key: &str) -> Option<String> {
    let stem = key.strip_suffix(RECORD_KEY_SUFFIX)?;
    let id = percent_decode_str(stem).decode_utf8().ok()?.into_owned();
    (key_of(&id) == key).then_some(id)
}

fn load_key(adapter: &dyn PersistenceAdapter, key: &str) -> LoadedKey {
    let malformed = || LoadedKey::Malformed(key.to_string());
    let Some(id) = id_of_key(key) else {
        return malformed();
    };
    let Ok(Some(bytes)) = adapter.load(key) else {
        return LoadedKey::Unreadable;
    };
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return malformed();
    };
    match parse_plain_json(text)
        .ok()
        .as_ref()
        .and_then(TaskRecord::from_wire)
    {
        Some(record) if record.id == id => LoadedKey::Record(Box::new(record)),
        _ => malformed(),
    }
}

fn load_all(adapter: &dyn PersistenceAdapter) -> Result<Vec<TaskRecord>, BoxError> {
    let keys = adapter.list("")?;
    let threads = TASK_RECORD_LOAD_CONCURRENCY.min(keys.len()).max(1);
    let share = keys.len().div_ceil(threads).max(1);
    let outcomes: Vec<LoadedKey> = std::thread::scope(|scope| {
        let readers: Vec<_> = keys
            .chunks(share)
            .map(|chunk| {
                scope.spawn(move || {
                    chunk
                        .iter()
                        .map(|key| load_key(adapter, key))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        readers
            .into_iter()
            .flat_map(|reader| reader.join().unwrap_or_default())
            .collect()
    });
    let mut loaded = Vec::new();
    for outcome in outcomes {
        match outcome {
            LoadedKey::Record(record) => loaded.push(*record),
            LoadedKey::Malformed(key) => {
                let _ = adapter.delete(&key);
            }
            LoadedKey::Unreadable => {}
        }
    }
    loaded.sort_by(|left, right| {
        left.created_at
            .total_cmp(&right.created_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(loaded)
}

fn adapter_stopped() -> BoxError {
    BoxError::from("The persistence adapter stopped before it finished the write")
}

async fn apply(adapter: &Arc<dyn PersistenceAdapter>, write: KeyWrite) {
    let (outcome, done) = match write {
        KeyWrite::Flush(done) => (Ok(()), Some(done)),
        KeyWrite::Save(key, bytes, done) => {
            let adapter = Arc::clone(adapter);
            let saved = tokio::task::spawn_blocking(move || adapter.save(&key, &bytes)).await;
            (saved.unwrap_or_else(|_| Err(adapter_stopped())), done)
        }
        KeyWrite::Delete(key, done) => {
            let adapter = Arc::clone(adapter);
            let deleted = tokio::task::spawn_blocking(move || adapter.delete(&key)).await;
            (deleted.unwrap_or_else(|_| Err(adapter_stopped())), done)
        }
    };
    if let Some(done) = done {
        let _ = done.send(outcome);
    }
}

async fn write_in_order(
    adapter: Arc<dyn PersistenceAdapter>,
    mut writes: mpsc::UnboundedReceiver<KeyWrite>,
) {
    while let Some(write) = writes.recv().await {
        apply(&adapter, write).await;
    }
}

fn prune(records: &mut Vec<TaskRecord>, max_retained: usize) -> Vec<String> {
    let mut evicted = Vec::new();
    let mut at = 0;
    while records.len() > max_retained && at < records.len() {
        if records[at].status.is_terminal() {
            evicted.push(records.remove(at).id);
        } else {
            at += 1;
        }
    }
    evicted
}

/// A [`TaskStore`] that writes every task record through a [`PersistenceAdapter`], so that a restarted server
/// still reports the tasks that it accepted before the restart, as the TypeScript server's `PersistenceTaskStore`
/// does.
///
/// The store writes each record as one JSON file under its ID, through the adapter's `save`, so a filesystem
/// adapter replaces each file atomically. It reads every record once, on the first call, and answers every later
/// read from memory, so one server must own the adapter's keys. Writes reach the adapter in the order of the
/// calls. The first read deletes every key that holds no readable record and skips a key that the adapter fails to
/// load. The store holds at most 1,000 records by default and drops the oldest finished records first, deleting
/// their keys, which bounds both the memory and the storage that task records take, and it ignores the
/// time-to-live of each write.
pub struct PersistenceTaskStore {
    adapter: Arc<dyn PersistenceAdapter>,
    max_retained: usize,
    records: Mutex<Vec<TaskRecord>>,
    loaded: OnceCell<()>,
    writer: Mutex<Option<mpsc::UnboundedSender<KeyWrite>>>,
}

impl PersistenceTaskStore {
    /// Returns a store over `adapter`, which it owns alone and whose every key that holds no task record it
    /// deletes, holding at most 1,000 records.
    pub fn new(adapter: Arc<dyn PersistenceAdapter>) -> PersistenceTaskStore {
        PersistenceTaskStore::with_max_retained(adapter, DEFAULT_MAX_RETAINED_TASKS)
    }

    /// Returns a store over `adapter` that holds at most `max_retained` records once their tasks finish.
    pub fn with_max_retained(
        adapter: Arc<dyn PersistenceAdapter>,
        max_retained: usize,
    ) -> PersistenceTaskStore {
        PersistenceTaskStore {
            adapter,
            max_retained,
            records: Mutex::new(Vec::new()),
            loaded: OnceCell::new(),
            writer: Mutex::new(None),
        }
    }

    fn records(&self) -> MutexGuard<'_, Vec<TaskRecord>> {
        match self.records.lock() {
            Ok(records) => records,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn enqueue(&self, write: KeyWrite) {
        let mut writer = match self.writer.lock() {
            Ok(writer) => writer,
            Err(poisoned) => poisoned.into_inner(),
        };
        let write = match writer.as_ref() {
            Some(sender) => match sender.send(write) {
                Ok(()) => return,
                Err(mpsc::error::SendError(write)) => write,
            },
            None => write,
        };
        let (sender, receiver) = mpsc::unbounded_channel();
        tokio::spawn(write_in_order(Arc::clone(&self.adapter), receiver));
        let _ = sender.send(write);
        *writer = Some(sender);
    }

    fn enqueue_evictions(&self, evicted: Vec<String>) {
        for id in evicted {
            self.enqueue(KeyWrite::Delete(key_of(&id), None));
        }
    }

    async fn ensure_loaded(&self) -> Result<(), BoxError> {
        self.loaded
            .get_or_try_init(|| async {
                let adapter = Arc::clone(&self.adapter);
                let loaded = tokio::task::spawn_blocking(move || load_all(&*adapter))
                    .await
                    .unwrap_or_else(|_| Err(adapter_stopped()))?;
                let evicted = {
                    let mut records = self.records();
                    *records = loaded;
                    prune(&mut records, self.max_retained)
                };
                self.enqueue_evictions(evicted);
                Ok::<(), BoxError>(())
            })
            .await
            .map(|_| ())
    }
}

async fn finished(written: oneshot::Receiver<Result<(), BoxError>>) -> Result<(), BoxError> {
    written.await.unwrap_or_else(|_| Err(adapter_stopped()))
}

impl TaskStore for PersistenceTaskStore {
    fn set(&self, record: TaskRecord, _ttl: Option<Duration>) -> StoreFuture<'_, ()> {
        Box::pin(async move {
            let json = write_plain_json(&record.to_wire());
            self.ensure_loaded().await?;
            let (done, written) = oneshot::channel();
            {
                let mut records = self.records();
                let key = key_of(&record.id);
                match records.iter_mut().find(|held| held.id == record.id) {
                    Some(held) => *held = record,
                    None => records.push(record),
                }
                self.enqueue(KeyWrite::Save(key, json.into_bytes(), Some(done)));
                let evicted = prune(&mut records, self.max_retained);
                self.enqueue_evictions(evicted);
            }
            finished(written).await
        })
    }

    fn get(&self, id: &str) -> StoreFuture<'_, Option<TaskRecord>> {
        let id = id.to_string();
        Box::pin(async move {
            self.ensure_loaded().await?;
            Ok(self.records().iter().find(|held| held.id == id).cloned())
        })
    }

    fn list(&self) -> StoreFuture<'_, Vec<TaskRecord>> {
        Box::pin(async move {
            self.ensure_loaded().await?;
            Ok(self.records().clone())
        })
    }

    fn delete(&self, id: &str) -> StoreFuture<'_, ()> {
        let id = id.to_string();
        Box::pin(async move {
            self.ensure_loaded().await?;
            let (done, written) = oneshot::channel();
            {
                let mut records = self.records();
                records.retain(|held| held.id != id);
                self.enqueue(KeyWrite::Delete(key_of(&id), Some(done)));
            }
            finished(written).await
        })
    }

    fn shutdown(&self) -> StoreFuture<'_, ()> {
        Box::pin(async move {
            let (done, flushed) = oneshot::channel();
            self.enqueue(KeyWrite::Flush(done));
            let _ = finished(flushed).await;
            Ok(())
        })
    }
}
