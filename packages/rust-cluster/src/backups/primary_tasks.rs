use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use narsil::{Map, Value};

use super::constants::BACKUP_PARTITION_RESULT_RETENTION_MS;
use crate::controller::lock;
use crate::error::{ClusterError, ClusterResult, codes};

#[derive(Clone)]
enum TaskState {
    Running,
    Done(Option<Value>, Instant),
    Failed(ClusterError, Instant),
}

type TaskKey = (String, String, u32);

pub(crate) struct PartitionTaskRef<'r> {
    pub(crate) job_id: &'r str,
    pub(crate) index_name: &'r str,
    pub(crate) partition_id: u32,
}

#[derive(Default)]
pub(crate) struct PartitionTasks {
    tasks: Arc<Mutex<HashMap<TaskKey, TaskState>>>,
}

pub(crate) fn failure_wire(error: &ClusterError) -> Value {
    let mut failure = Map::with_capacity(2);
    failure.insert("code", Value::from(error.code()));
    failure.insert("message", Value::from(error.message()));
    Value::Object(failure)
}

fn retention() -> Duration {
    Duration::from_millis(BACKUP_PARTITION_RESULT_RETENTION_MS)
}

fn drop_expired(tasks: &mut HashMap<TaskKey, TaskState>, now: Instant) {
    tasks.retain(|_, task| match task {
        TaskState::Running => true,
        TaskState::Done(_, finished) | TaskState::Failed(_, finished) => {
            now.duration_since(*finished) <= retention()
        }
    });
}

impl PartitionTasks {
    pub(crate) fn poll<F>(&self, task: &PartitionTaskRef<'_>, start: impl FnOnce() -> F) -> Value
    where
        F: Future<Output = ClusterResult<Option<Value>>> + Send + 'static,
    {
        let key = (
            task.job_id.to_string(),
            task.index_name.to_string(),
            task.partition_id,
        );
        let mut reply = Map::with_capacity(4);
        reply.insert("jobId", Value::from(task.job_id));
        reply.insert("partitionId", Value::from(task.partition_id));
        let state = {
            let mut tasks = lock(&self.tasks);
            drop_expired(&mut tasks, Instant::now());
            let known = tasks.get(&key).cloned();
            match &known {
                None => {
                    tasks.insert(key.clone(), TaskState::Running);
                }
                Some(TaskState::Failed(..)) => {
                    tasks.remove(&key);
                }
                Some(_) => {}
            }
            known
        };
        match state {
            None => {
                let running = tokio::spawn(start());
                let tasks = Arc::clone(&self.tasks);
                tokio::spawn(async move {
                    let settled = match running.await {
                        Ok(Ok(result)) => TaskState::Done(result, Instant::now()),
                        Ok(Err(error)) => TaskState::Failed(error, Instant::now()),
                        Err(_) => TaskState::Failed(
                            ClusterError::new(
                                codes::INTERNAL_ERROR,
                                "The partition task stopped before it finished",
                            ),
                            Instant::now(),
                        ),
                    };
                    lock(&tasks).insert(key, settled);
                });
                reply.insert("status", Value::from("running"));
            }
            Some(TaskState::Running) => {
                reply.insert("status", Value::from("running"));
            }
            Some(TaskState::Failed(error, _)) => {
                reply.insert("status", Value::from("failed"));
                reply.insert("error", failure_wire(&error));
            }
            Some(TaskState::Done(result, _)) => {
                reply.insert("status", Value::from("done"));
                if let Some(result) = result {
                    reply.insert("result", result);
                }
            }
        }
        Value::Object(reply)
    }
}
