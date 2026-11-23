use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::FutureExt;
use narsil::{Map, Value};
use tokio::sync::{mpsc, oneshot, watch};

use super::store::{TaskRecord, TaskStore};
use crate::constants::{RUNNING_TASK_TTL_MS, TASK_PROGRESS_WRITE_INTERVAL_MS};
use crate::errors::{ServerError, server_codes};
use crate::options::{BoxError, BoxFuture};

pub(crate) fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_millis() as f64)
}

pub(crate) enum TaskFailure {
    Coded(ServerError),
    Unexpected,
}

impl From<ServerError> for TaskFailure {
    fn from(failure: ServerError) -> TaskFailure {
        TaskFailure::Coded(failure)
    }
}

impl TaskFailure {
    pub(crate) fn error_object(&self) -> Map {
        let mut error = Map::new();
        match self {
            TaskFailure::Coded(failure) => {
                error.insert("code", Value::String(failure.code.clone()));
                error.insert("message", Value::String(failure.message.clone()));
                if let Some(details) = &failure.details {
                    error.insert("details", Value::Object(details.clone()));
                }
            }
            TaskFailure::Unexpected => {
                error.insert(
                    "code",
                    Value::String(server_codes::INTERNAL_ERROR.to_string()),
                );
                error.insert("message", Value::String("The operation failed".to_string()));
            }
        }
        error
    }
}

pub(crate) type TaskOutcome = Result<(), TaskFailure>;
pub(crate) type TaskOperation = Box<dyn FnOnce(TaskContext) -> BoxFuture<TaskOutcome> + Send>;

pub(crate) struct StoredRecord {
    stored: oneshot::Receiver<Result<(), BoxError>>,
}

impl StoredRecord {
    pub(crate) async fn wait(self) -> Result<(), BoxError> {
        self.stored.await.unwrap_or_else(|_| Err(store_stopped()))
    }
}

pub(crate) struct TaskWrite {
    pub(crate) record: TaskRecord,
    pub(crate) ttl: Duration,
    pub(crate) done: Option<oneshot::Sender<Result<(), BoxError>>>,
}

struct TaskState {
    record: TaskRecord,
    last_progress_write_ms: f64,
    settled: bool,
}

pub(crate) struct LiveTask {
    state: Mutex<TaskState>,
    cancelled: AtomicBool,
    writes: mpsc::UnboundedSender<TaskWrite>,
    finished: watch::Sender<bool>,
}

fn store_stopped() -> BoxError {
    BoxError::from("The task store stopped before it stored the record")
}

fn store_failed() -> BoxError {
    BoxError::from("The task store failed while it stored the record")
}

async fn write_in_order(store: Arc<dyn TaskStore>, mut writes: mpsc::UnboundedReceiver<TaskWrite>) {
    while let Some(first) = writes.recv().await {
        let mut latest = first;
        let mut waiting = Vec::new();
        while let Ok(later) = writes.try_recv() {
            if let Some(done) = latest.done.take() {
                waiting.push(done);
            }
            latest = later;
        }
        if let Some(done) = latest.done.take() {
            waiting.push(done);
        }
        let stored = AssertUnwindSafe(store.set(latest.record, Some(latest.ttl)))
            .catch_unwind()
            .await
            .unwrap_or_else(|_| Err(store_failed()));
        let shared = stored.map_err(|failure| failure.to_string());
        for done in waiting {
            let _ = done.send(shared.clone().map_err(BoxError::from));
        }
    }
}

impl LiveTask {
    pub(crate) fn new(record: TaskRecord, store: Arc<dyn TaskStore>) -> Arc<LiveTask> {
        let (writes, queued) = mpsc::unbounded_channel();
        tokio::spawn(write_in_order(store, queued));
        let created_at = record.created_at;
        Arc::new(LiveTask {
            state: Mutex::new(TaskState {
                record,
                last_progress_write_ms: created_at,
                settled: false,
            }),
            cancelled: AtomicBool::new(false),
            writes,
            finished: watch::Sender::new(false),
        })
    }

    fn state(&self) -> MutexGuard<'_, TaskState> {
        match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    pub(crate) fn record(&self) -> TaskRecord {
        self.state().record.clone()
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    pub(crate) fn request_cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    fn enqueue(&self, record: TaskRecord, ttl: Duration) -> StoredRecord {
        let (done, stored) = oneshot::channel();
        let _ = self.writes.send(TaskWrite {
            record,
            ttl,
            done: Some(done),
        });
        StoredRecord { stored }
    }

    pub(crate) fn write_first(&self) -> StoredRecord {
        let state = self.state();
        self.enqueue(
            state.record.clone(),
            Duration::from_millis(RUNNING_TASK_TTL_MS),
        )
    }

    pub(crate) async fn mark_cancel_requested(&self) -> Option<TaskRecord> {
        let (record, stored) = {
            let mut state = self.state();
            if state.settled {
                return None;
            }
            state.record.cancel_requested_at = Some(now_ms());
            let record = state.record.clone();
            let stored = self.enqueue(record.clone(), Duration::from_millis(RUNNING_TASK_TTL_MS));
            (record, stored)
        };
        let _ = stored.wait().await;
        Some(record)
    }

    pub(crate) fn settle(&self, outcome: &TaskOutcome, ttl: Duration) -> StoredRecord {
        let cancelled = self.is_cancelled();
        let mut state = self.state();
        state.settled = true;
        let record = &mut state.record;
        match outcome {
            Ok(()) => record.status = super::TaskStatus::Succeeded,
            Err(_) if cancelled => record.status = super::TaskStatus::Cancelled,
            Err(failure) => {
                record.status = super::TaskStatus::Failed;
                record.error = Some(failure.error_object());
            }
        }
        record.completed_at = Some(now_ms());
        let settled = record.clone();
        self.enqueue(settled, ttl)
    }

    pub(crate) fn mark_finished(&self) {
        self.finished.send_replace(true);
    }

    pub(crate) async fn wait_finished(&self) {
        let mut finished = self.finished.subscribe();
        let _ = finished.wait_for(|done| *done).await;
    }

    fn report(&self, change: impl FnOnce(&mut TaskRecord)) {
        let mut state = self.state();
        if state.settled {
            return;
        }
        change(&mut state.record);
        let now = now_ms();
        if now - state.last_progress_write_ms < TASK_PROGRESS_WRITE_INTERVAL_MS as f64 {
            return;
        }
        state.last_progress_write_ms = now;
        let _ = self.writes.send(TaskWrite {
            record: state.record.clone(),
            ttl: Duration::from_millis(RUNNING_TASK_TTL_MS),
            done: None,
        });
    }

    fn keep(&self, change: impl FnOnce(&mut TaskRecord)) {
        let mut state = self.state();
        if !state.settled {
            change(&mut state.record);
        }
    }
}

#[derive(Clone)]
pub(crate) struct TaskContext {
    task: Arc<LiveTask>,
}

impl TaskContext {
    pub(crate) fn of(task: Arc<LiveTask>) -> TaskContext {
        TaskContext { task }
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.task.is_cancelled()
    }

    pub(crate) fn report_progress(&self, progress: Map) {
        self.task.report(|record| record.progress = Some(progress));
    }

    #[cfg(feature = "cluster")]
    pub(crate) fn report_steps(&self, steps: Map) {
        self.task.report(|record| record.steps = Some(steps));
    }

    pub(crate) fn report_result(&self, result: Map) {
        self.task.keep(|record| record.result = Some(result));
    }

    pub(crate) fn report_build(&self, build: Map) {
        self.task.keep(|record| record.build = Some(build));
    }
}
