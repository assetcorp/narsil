use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;
use std::time::Duration;

use narsil::{Map, Value};

use crate::constants::DEFAULT_MAX_RETAINED_TASKS;
use crate::options::BoxError;

/// A future that a [`TaskStore`] returns.
pub type StoreFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, BoxError>> + Send + 'a>>;

/// The state of a task.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TaskStatus {
    /// The task has not finished.
    Running,
    /// The task finished its work.
    Succeeded,
    /// The task stopped on an error, which the record's `error` holds.
    Failed,
    /// The task stopped because a caller asked it to.
    Cancelled,
}

impl TaskStatus {
    /// Returns the status as the wire spells it, such as `running`.
    pub fn as_str(self) -> &'static str {
        match self {
            TaskStatus::Running => "running",
            TaskStatus::Succeeded => "succeeded",
            TaskStatus::Failed => "failed",
            TaskStatus::Cancelled => "cancelled",
        }
    }

    /// Returns the status that the wire spells as `text`, or `None` for any other text.
    pub fn from_wire(text: &str) -> Option<TaskStatus> {
        match text {
            "running" => Some(TaskStatus::Running),
            "succeeded" => Some(TaskStatus::Succeeded),
            "failed" => Some(TaskStatus::Failed),
            "cancelled" => Some(TaskStatus::Cancelled),
            _ => None,
        }
    }

    /// Reports whether the task has finished, which every status except [`TaskStatus::Running`] means.
    pub fn is_terminal(self) -> bool {
        self != TaskStatus::Running
    }
}

/// One task record, with the fields of the TypeScript server's `TaskRecord`.
#[derive(Debug, Clone, PartialEq)]
pub struct TaskRecord {
    /// The task's identifier.
    pub id: String,
    /// The kind of task, such as `import` or `optimizeVectors`.
    pub task_type: String,
    /// The index that the task works on.
    pub index_name: String,
    /// The backup that the task works on, for a backup task.
    pub backup_name: Option<String>,
    /// The state of the task.
    pub status: TaskStatus,
    /// The identifier of the server instance that runs the task.
    pub owner: String,
    /// When the server accepted the task, in Unix milliseconds.
    pub created_at: f64,
    /// When the task started, in Unix milliseconds.
    pub started_at: Option<f64>,
    /// When the task finished, in Unix milliseconds.
    pub completed_at: Option<f64>,
    /// When a caller asked the task to stop, in Unix milliseconds.
    pub cancel_requested_at: Option<f64>,
    /// The import progress, as the wire's `progress` object.
    pub progress: Option<Map>,
    /// The step progress, as the wire's `steps` object.
    pub steps: Option<Map>,
    /// The import result, as the wire's `result` object.
    pub result: Option<Map>,
    /// The query suggestions build, as the wire's `build` object.
    pub build: Option<Map>,
    /// The error of a failed task, as the wire's `error` object.
    pub error: Option<Map>,
}

pub(crate) const TASK_TYPES: [&str; 11] = [
    "optimizeVectors",
    "rebalance",
    "restore",
    "import",
    "importExport",
    "rebuildAnalysis",
    "changeAnalysis",
    "backup",
    "backupRestore",
    "backupDelete",
    "querySuggestionsBuild",
];

fn insert_time(out: &mut Map, key: &str, time: Option<f64>) {
    if let Some(time) = time {
        out.insert(key, Value::Number(time));
    }
}

fn insert_object(out: &mut Map, key: &str, object: &Option<Map>) {
    if let Some(object) = object {
        out.insert(key, Value::Object(object.clone()));
    }
}

fn text_of(fields: &Map, key: &str) -> Option<String> {
    fields.get(key).and_then(Value::as_str).map(str::to_string)
}

fn time_of(fields: &Map, key: &str) -> Option<f64> {
    match fields.get(key) {
        Some(Value::Number(time)) if time.is_finite() => Some(*time),
        _ => None,
    }
}

fn object_of(fields: &Map, key: &str) -> Option<Map> {
    match fields.get(key) {
        Some(Value::Object(object)) => Some(object.clone()),
        _ => None,
    }
}

impl TaskRecord {
    /// Returns the record as the JSON object that `GET /tasks/{id}` answers with, with its fields in the order
    /// that the TypeScript server writes them.
    pub fn to_wire(&self) -> Value {
        let mut out = Map::new();
        out.insert("id", Value::String(self.id.clone()));
        out.insert("type", Value::String(self.task_type.clone()));
        out.insert("indexName", Value::String(self.index_name.clone()));
        if let Some(backup_name) = &self.backup_name {
            out.insert("backupName", Value::String(backup_name.clone()));
        }
        out.insert("owner", Value::String(self.owner.clone()));
        out.insert("status", Value::String(self.status.as_str().to_string()));
        out.insert("createdAt", Value::Number(self.created_at));
        insert_time(&mut out, "startedAt", self.started_at);
        insert_object(&mut out, "progress", &self.progress);
        insert_object(&mut out, "steps", &self.steps);
        insert_time(&mut out, "cancelRequestedAt", self.cancel_requested_at);
        insert_object(&mut out, "result", &self.result);
        insert_object(&mut out, "build", &self.build);
        insert_object(&mut out, "error", &self.error);
        insert_time(&mut out, "completedAt", self.completed_at);
        Value::Object(out)
    }

    /// Returns the record that `value` holds in the shape that [`TaskRecord::to_wire`] writes, or `None` where
    /// `value` lacks a string `id`, `indexName`, or `owner`, a known `type` or `status`, or a finite `createdAt`.
    ///
    /// An optional field of the wrong type reads as absent.
    pub fn from_wire(value: &Value) -> Option<TaskRecord> {
        let Value::Object(fields) = value else {
            return None;
        };
        let task_type =
            text_of(fields, "type").filter(|kind| TASK_TYPES.contains(&kind.as_str()))?;
        Some(TaskRecord {
            id: text_of(fields, "id")?,
            task_type,
            index_name: text_of(fields, "indexName")?,
            backup_name: text_of(fields, "backupName"),
            status: fields
                .get("status")
                .and_then(Value::as_str)
                .and_then(TaskStatus::from_wire)?,
            owner: text_of(fields, "owner")?,
            created_at: time_of(fields, "createdAt")?,
            started_at: time_of(fields, "startedAt"),
            completed_at: time_of(fields, "completedAt"),
            cancel_requested_at: time_of(fields, "cancelRequestedAt"),
            progress: object_of(fields, "progress"),
            steps: object_of(fields, "steps"),
            result: object_of(fields, "result"),
            build: object_of(fields, "build"),
            error: object_of(fields, "error"),
        })
    }
}

/// Keeps task records, which the server writes as each task starts, moves, and finishes.
pub trait TaskStore: Send + Sync + 'static {
    /// Stores `record` in place of any record with its identifier, to expire after `ttl` where the store expires
    /// records.
    fn set(&self, record: TaskRecord, ttl: Option<Duration>) -> StoreFuture<'_, ()>;
    /// Returns the record with identifier `id`, or `None`.
    fn get(&self, id: &str) -> StoreFuture<'_, Option<TaskRecord>>;
    /// Returns every record that the store holds.
    fn list(&self) -> StoreFuture<'_, Vec<TaskRecord>>;
    /// Removes the record with identifier `id`.
    fn delete(&self, id: &str) -> StoreFuture<'_, ()>;
    /// Releases what the store holds open, which the server calls as it closes.
    fn shutdown(&self) -> StoreFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }
}

/// Keeps task records in memory, holding at most 1,000 by default and dropping the oldest finished records first.
pub struct InMemoryTaskStore {
    max_retained: usize,
    records: Mutex<VecDeque<TaskRecord>>,
}

impl Default for InMemoryTaskStore {
    fn default() -> InMemoryTaskStore {
        InMemoryTaskStore::new(DEFAULT_MAX_RETAINED_TASKS)
    }
}

impl InMemoryTaskStore {
    /// Returns an empty store that holds at most `max_retained` records once their tasks finish.
    pub fn new(max_retained: usize) -> InMemoryTaskStore {
        InMemoryTaskStore {
            max_retained,
            records: Mutex::new(VecDeque::new()),
        }
    }

    fn with_records<T>(&self, action: impl FnOnce(&mut VecDeque<TaskRecord>) -> T) -> T {
        let mut records = match self.records.lock() {
            Ok(records) => records,
            Err(poisoned) => poisoned.into_inner(),
        };
        action(&mut records)
    }
}

fn prune(records: &mut VecDeque<TaskRecord>, max_retained: usize) {
    let mut at = 0;
    while records.len() > max_retained && at < records.len() {
        if records[at].status.is_terminal() {
            records.remove(at);
        } else {
            at += 1;
        }
    }
}

impl TaskStore for InMemoryTaskStore {
    fn set(&self, record: TaskRecord, _ttl: Option<Duration>) -> StoreFuture<'_, ()> {
        self.with_records(|records| {
            match records.iter_mut().find(|held| held.id == record.id) {
                Some(held) => *held = record,
                None => records.push_back(record),
            }
            prune(records, self.max_retained);
        });
        Box::pin(async { Ok(()) })
    }

    fn get(&self, id: &str) -> StoreFuture<'_, Option<TaskRecord>> {
        let found = self.with_records(|records| records.iter().find(|held| held.id == id).cloned());
        Box::pin(async move { Ok(found) })
    }

    fn list(&self) -> StoreFuture<'_, Vec<TaskRecord>> {
        let all = self.with_records(|records| records.iter().cloned().collect());
        Box::pin(async move { Ok(all) })
    }

    fn delete(&self, id: &str) -> StoreFuture<'_, ()> {
        self.with_records(|records| records.retain(|held| held.id != id));
        Box::pin(async { Ok(()) })
    }
}
