use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::{Duration, Instant};

use narsil::{Map, Value};
use tokio::task::JoinSet;

use super::constants::{BACKUP_PARTITION_POLL_INTERVAL_MS, BACKUP_PRIMARY_WAIT_MS};
use super::driver_context::BackupDriverContext;
use super::exchange::{Exchange, exchange_message, node_targets};
use crate::allocator::ACTIVE;
use crate::controller::stored_table;
use crate::error::{ClusterError, ClusterResult, codes};

const RETRIED_CODES: [&str; 4] = [
    codes::QUERY_NO_ACTIVE_REPLICA,
    codes::PARTITION_NOT_PRIMARY,
    codes::NODE_NOT_READY,
    codes::NODE_NOT_JOINED,
];

pub(crate) struct PartitionTask {
    pub(crate) message_type: &'static str,
    pub(crate) job_id: String,
    pub(crate) backup_name: String,
    pub(crate) index_name: String,
    pub(crate) partition_id: u32,
}

pub(crate) struct PartitionTaskOutcome {
    pub(crate) result: Option<Value>,
    pub(crate) primary_term: f64,
}

impl PartitionTask {
    fn payload(&self) -> Value {
        let mut payload = Map::with_capacity(4);
        payload.insert("jobId", Value::from(self.job_id.as_str()));
        payload.insert("backupName", Value::from(self.backup_name.as_str()));
        payload.insert("indexName", Value::from(self.index_name.as_str()));
        payload.insert("partitionId", Value::from(self.partition_id));
        Value::Object(payload)
    }

    fn details(&self) -> Map {
        let mut details = Map::with_capacity(2);
        details.insert("indexName", Value::from(self.index_name.as_str()));
        details.insert("partitionId", Value::from(self.partition_id));
        details
    }

    fn no_primary(&self) -> ClusterError {
        ClusterError::new(
            codes::QUERY_NO_ACTIVE_REPLICA,
            format!(
                "Partition {} of index '{}' had no active primary for {BACKUP_PRIMARY_WAIT_MS} ms",
                self.partition_id, self.index_name
            ),
        )
        .with_detail("indexName", Value::from(self.index_name.as_str()))
        .with_detail("partitionId", Value::from(self.partition_id))
    }

    fn unreadable(&self, primary: &str) -> ClusterError {
        ClusterError::new(
            codes::ALLOCATION_FAILED,
            format!(
                "Node '{primary}' sent an unreadable answer for partition {} of index '{}'",
                self.partition_id, self.index_name
            ),
        )
        .with_detail("indexName", Value::from(self.index_name.as_str()))
        .with_detail("partitionId", Value::from(self.partition_id))
        .with_detail("nodeId", Value::from(primary))
    }

    fn failure_of(&self, reply: &Map, primary: &str) -> ClusterError {
        let Some(Value::Object(error)) = reply.get("error") else {
            return self.unreadable(primary);
        };
        let code = match error.get("code") {
            Some(Value::String(code)) => code.clone(),
            _ => codes::ALLOCATION_FAILED.to_string(),
        };
        let message = match error.get("message") {
            Some(Value::String(message)) => message.clone(),
            _ => format!("Partition {} failed", self.partition_id),
        };
        ClusterError::new(code, message)
            .with_detail("indexName", Value::from(self.index_name.as_str()))
            .with_detail("partitionId", Value::from(self.partition_id))
            .with_detail("nodeId", Value::from(primary))
    }
}

fn is_retried(error: &ClusterError) -> bool {
    RETRIED_CODES.contains(&error.code())
}

async fn active_primary_of(
    context: &BackupDriverContext,
    task: &PartitionTask,
) -> ClusterResult<Option<(String, f64)>> {
    let table = stored_table(context.coordinator(), &task.index_name).await?;
    let assignment = table
        .as_ref()
        .and_then(|table| table.assignments.get(f64::from(task.partition_id)));
    Ok(assignment
        .filter(|assignment| assignment.state == ACTIVE)
        .and_then(|assignment| {
            assignment
                .primary
                .clone()
                .map(|primary| (primary, assignment.primary_term))
        }))
}

async fn ask_primary(
    context: &BackupDriverContext,
    task: &PartitionTask,
    primary: &str,
) -> ClusterResult<Map> {
    let mut details = task.details();
    details.insert("targetNodeId", Value::from(primary));
    exchange_message(Exchange {
        transport: context.deps.transport.as_ref(),
        sender_id: context.node_id(),
        targets: node_targets(context.coordinator(), primary).await?,
        message_type: task.message_type,
        payload: task.payload(),
        failure_message: format!(
            "Node '{primary}' did not answer for partition {} of index '{}'",
            task.partition_id, task.index_name
        ),
        details,
    })
    .await
}

enum Polled {
    Done(Option<Value>),
    Running,
}

fn read_reply(reply: &Map, task: &PartitionTask, primary: &str) -> ClusterResult<Polled> {
    let same_job = reply.get("jobId").and_then(Value::as_str) == Some(task.job_id.as_str());
    let same_partition =
        reply.get("partitionId").and_then(Value::as_f64) == Some(f64::from(task.partition_id));
    if !same_job || !same_partition {
        return Err(task.unreadable(primary));
    }
    match reply.get("status").and_then(Value::as_str) {
        Some("done") => Ok(Polled::Done(reply.get("result").cloned())),
        Some("failed") => Err(task.failure_of(reply, primary)),
        Some("running") => Ok(Polled::Running),
        _ => Err(task.unreadable(primary)),
    }
}

pub(crate) async fn drive_partition_task(
    context: &BackupDriverContext,
    task: &PartitionTask,
) -> ClusterResult<PartitionTaskOutcome> {
    let wait = Duration::from_millis(BACKUP_PRIMARY_WAIT_MS);
    let poll = Duration::from_millis(BACKUP_PARTITION_POLL_INTERVAL_MS);
    let mut deadline = Instant::now() + wait;
    loop {
        context.assert_still_driving()?;
        let Some((primary, primary_term)) = active_primary_of(context, task).await? else {
            if Instant::now() > deadline {
                return Err(task.no_primary());
            }
            tokio::time::sleep(poll).await;
            continue;
        };
        let polled = ask_primary(context, task, &primary)
            .await
            .and_then(|reply| read_reply(&reply, task, &primary));
        match polled {
            Ok(Polled::Done(result)) => {
                return Ok(PartitionTaskOutcome {
                    result,
                    primary_term,
                });
            }
            Ok(Polled::Running) => deadline = Instant::now() + wait,
            Err(error) if is_retried(&error) && Instant::now() <= deadline => {}
            Err(error) => return Err(error),
        }
        tokio::time::sleep(poll).await;
    }
}

pub(crate) async fn for_each_partition<F, Fut>(
    partition_count: u32,
    at_once: usize,
    task: F,
) -> ClusterResult<()>
where
    F: Fn(u32) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = ClusterResult<()>> + Send + 'static,
{
    let task = Arc::new(task);
    let next = Arc::new(AtomicU32::new(0));
    let failed = Arc::new(AtomicBool::new(false));
    let mut workers = JoinSet::new();
    for _ in 0..at_once.min(partition_count as usize) {
        let (task, next, failed) = (Arc::clone(&task), Arc::clone(&next), Arc::clone(&failed));
        workers.spawn(async move {
            while !failed.load(Ordering::Acquire) {
                let partition_id = next.fetch_add(1, Ordering::AcqRel);
                if partition_id >= partition_count {
                    break;
                }
                if let Err(error) = task(partition_id).await {
                    failed.store(true, Ordering::Release);
                    return Err(error);
                }
            }
            Ok(())
        });
    }
    while let Some(joined) = workers.join_next().await {
        let outcome = joined.unwrap_or_else(|_| {
            Err(ClusterError::new(
                codes::INTERNAL_ERROR,
                "A partition task of a backup job stopped before it finished",
            ))
        });
        outcome?;
    }
    Ok(())
}
