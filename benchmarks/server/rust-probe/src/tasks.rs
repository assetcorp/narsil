use std::collections::{HashMap, HashSet, VecDeque};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::http::StatusCode;
use narsil::Narsil;
use serde::Serialize;

use crate::constants::{MAX_RETAINED_TASKS, MAX_RUNNING_TASKS};
use crate::errors::ApiError;

#[derive(Serialize, Clone)]
pub struct TaskFailure {
    code: String,
    message: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecord {
    id: String,
    #[serde(rename = "type")]
    kind: &'static str,
    index_name: String,
    status: &'static str,
    created_at: u64,
    started_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<TaskFailure>,
}

#[derive(Default)]
struct TaskState {
    records: HashMap<String, TaskRecord>,
    order: VecDeque<String>,
    running: usize,
    building: HashMap<String, usize>,
}

pub struct TaskStore {
    state: Mutex<TaskState>,
    next: AtomicU64,
    instance: u128,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

impl TaskState {
    fn evict_finished(&mut self) {
        while self.records.len() > MAX_RETAINED_TASKS {
            let Some(place) = self.order.iter().position(|id| {
                self.records
                    .get(id)
                    .is_some_and(|record| record.status != "running")
            }) else {
                return;
            };
            if let Some(id) = self.order.remove(place) {
                self.records.remove(&id);
            }
        }
    }

    fn finish(&mut self, id: &str, index: &str, failure: Option<TaskFailure>) {
        self.running = self.running.saturating_sub(1);
        if let Some(count) = self.building.get_mut(index) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                self.building.remove(index);
            }
        }
        if let Some(record) = self.records.get_mut(id) {
            record.status = if failure.is_some() {
                "failed"
            } else {
                "succeeded"
            };
            record.completed_at = Some(now_ms());
            record.error = failure;
        }
        self.evict_finished();
    }
}

impl TaskStore {
    pub fn new() -> TaskStore {
        let instance = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        TaskStore {
            state: Mutex::new(TaskState::default()),
            next: AtomicU64::new(1),
            instance,
        }
    }

    fn lock(&self) -> MutexGuard<'_, TaskState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn get(&self, id: &str) -> Option<TaskRecord> {
        self.lock().records.get(id).cloned()
    }

    pub fn building_indexes(&self) -> HashSet<String> {
        self.lock().building.keys().cloned().collect()
    }

    pub fn start_optimize(
        self: &Arc<Self>,
        engine: Arc<Narsil>,
        index: String,
        field: Option<String>,
    ) -> Result<TaskRecord, ApiError> {
        let sequence = self.next.fetch_add(1, Ordering::Relaxed);
        let id = format!("{:032x}-{sequence:016x}", self.instance);
        let started = now_ms();
        let record = TaskRecord {
            id: id.clone(),
            kind: "optimizeVectors",
            index_name: index.clone(),
            status: "running",
            created_at: started,
            started_at: started,
            completed_at: None,
            error: None,
        };
        {
            let mut state = self.lock();
            if state.running >= MAX_RUNNING_TASKS {
                return Err(ApiError::new(
                    StatusCode::TOO_MANY_REQUESTS,
                    "TOO_MANY_REQUESTS",
                    format!("At most {MAX_RUNNING_TASKS} tasks run at once"),
                ));
            }
            state.running += 1;
            *state.building.entry(index.clone()).or_insert(0) += 1;
            state.records.insert(id.clone(), record.clone());
            state.order.push_back(id.clone());
            state.evict_finished();
        }
        let store = Arc::clone(self);
        let task_index = index.clone();
        let task_id = id.clone();
        let spawned = std::thread::Builder::new()
            .name(format!("narsil-task-{sequence}"))
            .spawn(move || {
                let outcome = catch_unwind(AssertUnwindSafe(|| {
                    engine.optimize_vectors(&task_index, field.as_deref())
                }));
                let failure = match outcome {
                    Ok(Ok(())) => None,
                    Ok(Err(error)) => Some(TaskFailure {
                        code: error.code().as_str().to_owned(),
                        message: error.message().to_owned(),
                    }),
                    Err(_) => Some(TaskFailure {
                        code: "INTERNAL_ERROR".to_owned(),
                        message: "The task panicked".to_owned(),
                    }),
                };
                store.lock().finish(&task_id, &task_index, failure);
            });
        if spawned.is_err() {
            self.lock().finish(
                &id,
                &index,
                Some(TaskFailure {
                    code: "INTERNAL_ERROR".to_owned(),
                    message: "The task thread could not start".to_owned(),
                }),
            );
            return Err(ApiError::internal("The task thread could not start"));
        }
        Ok(record)
    }
}
