use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use futures_util::FutureExt;
use narsil::{Map, NarsilError, Value};
use tokio::sync::oneshot;

use super::listing::{TaskListPage, TaskListQuery, page_of};
use super::live::{LiveTask, TaskContext, TaskFailure, TaskOperation, now_ms};
use super::store::{TaskRecord, TaskStatus, TaskStore};
use crate::constants::TERMINAL_TASK_TTL_MS;
use crate::errors::{Outcome, ServerError, server_codes};
use crate::ids::random_uuid;
use crate::options::BoxError;

type LiveTasks = Arc<Mutex<HashMap<String, Arc<LiveTask>>>>;

pub(crate) struct TaskLaunch {
    pub(crate) task_type: &'static str,
    pub(crate) index_name: String,
    pub(crate) backup_name: Option<String>,
    pub(crate) progress: Option<Map>,
}

impl TaskLaunch {
    pub(crate) fn on(task_type: &'static str, index_name: &str) -> TaskLaunch {
        TaskLaunch {
            task_type,
            index_name: index_name.to_string(),
            backup_name: None,
            progress: None,
        }
    }
}

pub(crate) enum CancelOutcome {
    Cancelling(Box<TaskRecord>),
    NotFound,
    AlreadyFinished(TaskStatus),
    OwnedByAnotherInstance(String),
}

pub(crate) struct TaskRegistry {
    store: Arc<dyn TaskStore>,
    instance_id: String,
    max_concurrent: u64,
    live: LiveTasks,
}

fn lock(live: &LiveTasks) -> MutexGuard<'_, HashMap<String, Arc<LiveTask>>> {
    match live.lock() {
        Ok(tasks) => tasks,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn store_failure(failure: &BoxError) -> ServerError {
    match failure.downcast_ref::<NarsilError>() {
        Some(coded) => ServerError::from(coded.clone()),
        None => ServerError::internal(),
    }
}

fn interrupted(record: TaskRecord) -> TaskRecord {
    let mut error = Map::new();
    error.insert(
        "code",
        Value::String(server_codes::TASK_INTERRUPTED.to_string()),
    );
    error.insert(
        "message",
        Value::String("The server restarted while this task was running".to_string()),
    );
    TaskRecord {
        status: TaskStatus::Failed,
        completed_at: Some(now_ms()),
        error: Some(error),
        ..record
    }
}

async fn drive(live: LiveTasks, task: Arc<LiveTask>, operation: TaskOperation) {
    let context = TaskContext::of(Arc::clone(&task));
    let outcome = AssertUnwindSafe(async move { operation(context).await })
        .catch_unwind()
        .await
        .unwrap_or(Err(TaskFailure::Unexpected));
    let settled = task.settle(&outcome, Duration::from_millis(TERMINAL_TASK_TTL_MS));
    let _ = settled.wait().await;
    lock(&live).remove(&task.record().id);
    task.mark_finished();
}

impl TaskRegistry {
    pub(crate) fn new(
        store: Arc<dyn TaskStore>,
        instance_id: String,
        max_concurrent: u64,
    ) -> TaskRegistry {
        TaskRegistry {
            store,
            instance_id,
            max_concurrent,
            live: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn admit(&self, task: &Arc<LiveTask>, id: &str) -> Outcome<()> {
        let mut live = lock(&self.live);
        let running = live.len() as u64;
        if self.max_concurrent > 0 && running >= self.max_concurrent {
            let mut details = Map::new();
            details.insert("running", Value::Number(running as f64));
            details.insert("limit", Value::Number(self.max_concurrent as f64));
            return Err(ServerError::new(
                429,
                server_codes::TOO_MANY_REQUESTS,
                format!(
                    "This instance already drives {} tasks; poll one to completion before starting another",
                    self.max_concurrent
                ),
            )
            .with_details(details));
        }
        live.insert(id.to_string(), Arc::clone(task));
        Ok(())
    }

    pub(crate) async fn start(
        &self,
        launch: TaskLaunch,
        operation: TaskOperation,
    ) -> Outcome<TaskRecord> {
        let id = random_uuid().ok_or_else(ServerError::internal)?;
        let now = now_ms();
        let record = TaskRecord {
            id: id.clone(),
            task_type: launch.task_type.to_string(),
            index_name: launch.index_name,
            backup_name: launch.backup_name,
            status: TaskStatus::Running,
            owner: self.instance_id.clone(),
            created_at: now,
            started_at: Some(now),
            completed_at: None,
            cancel_requested_at: None,
            progress: launch.progress,
            steps: None,
            result: None,
            build: None,
            error: None,
        };
        let task = LiveTask::new(record.clone(), Arc::clone(&self.store));
        self.admit(&task, &id)?;
        let first = task.write_first();
        let (accepted, answer) = oneshot::channel();
        let (live, store) = (Arc::clone(&self.live), Arc::clone(&self.store));
        tokio::spawn(async move {
            match first.wait().await {
                Ok(()) => {
                    let _ = accepted.send(Ok(()));
                    drive(live, task, operation).await;
                }
                Err(failure) => {
                    lock(&live).remove(&id);
                    let _ = AssertUnwindSafe(store.delete(&id)).catch_unwind().await;
                    task.mark_finished();
                    let _ = accepted.send(Err(store_failure(&failure)));
                }
            }
        });
        match answer.await {
            Ok(Ok(())) => Ok(record),
            Ok(Err(failure)) => Err(failure),
            Err(_) => Err(ServerError::internal()),
        }
    }

    pub(crate) async fn get(&self, id: &str) -> Result<Option<TaskRecord>, BoxError> {
        self.store.get(id).await
    }

    pub(crate) async fn list(&self, query: &TaskListQuery) -> Result<TaskListPage, BoxError> {
        let records = self.store.list().await?;
        Ok(page_of(records, query))
    }

    pub(crate) async fn cancel(&self, id: &str) -> Result<CancelOutcome, BoxError> {
        let Some(stored) = self.store.get(id).await? else {
            return Ok(CancelOutcome::NotFound);
        };
        if stored.status.is_terminal() {
            return Ok(CancelOutcome::AlreadyFinished(stored.status));
        }
        let task = lock(&self.live).get(id).cloned();
        let Some(task) = task else {
            return Ok(if stored.owner == self.instance_id {
                CancelOutcome::AlreadyFinished(stored.status)
            } else {
                CancelOutcome::OwnedByAnotherInstance(stored.owner)
            });
        };
        task.request_cancel();
        Ok(match task.mark_cancel_requested().await {
            Some(record) => CancelOutcome::Cancelling(Box::new(record)),
            None => CancelOutcome::AlreadyFinished(task.record().status),
        })
    }

    pub(crate) async fn reconcile(&self) {
        let Ok(records) = self.store.list().await else {
            return;
        };
        for record in records {
            if record.owner != self.instance_id || record.status.is_terminal() {
                continue;
            }
            if lock(&self.live).contains_key(&record.id) {
                continue;
            }
            let failed = interrupted(record);
            let _ = AssertUnwindSafe(
                self.store
                    .set(failed, Some(Duration::from_millis(TERMINAL_TASK_TTL_MS))),
            )
            .catch_unwind()
            .await;
        }
    }

    pub(crate) async fn shutdown(&self) {
        let tasks: Vec<Arc<LiveTask>> = lock(&self.live).values().cloned().collect();
        for task in &tasks {
            task.request_cancel();
        }
        for task in &tasks {
            task.wait_finished().await;
        }
        let _ = AssertUnwindSafe(self.store.shutdown()).catch_unwind().await;
    }
}
