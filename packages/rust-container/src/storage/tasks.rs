use narsil::{Map, Value};
use narsil_server::{BoxError, TaskRecord, TaskStatus, TaskStore, server_codes};

use crate::events::body::now_ms;

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
        completed_at: Some(now_ms() as f64),
        error: Some(error),
        ..record
    }
}

pub async fn reconcile_local_tasks(store: &dyn TaskStore) -> Result<(), BoxError> {
    for record in store.list().await? {
        if record.status == TaskStatus::Running {
            store.set(interrupted(record), None).await?;
        }
    }
    Ok(())
}
