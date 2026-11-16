use std::sync::Arc;
use std::time::Duration;

use narsil_server::{StoreFuture, TaskRecord, TaskStore};

use super::sink::EventSink;
use super::types::TASK_FINISHED_TYPE;

pub struct TaskEventStore {
    inner: Arc<dyn TaskStore>,
    sink: EventSink,
}

impl TaskEventStore {
    pub fn new(inner: Arc<dyn TaskStore>, sink: EventSink) -> TaskEventStore {
        TaskEventStore { inner, sink }
    }
}

impl TaskStore for TaskEventStore {
    fn set(&self, record: TaskRecord, ttl: Option<Duration>) -> StoreFuture<'_, ()> {
        Box::pin(async move {
            let finished = record.status.is_terminal().then(|| record.to_wire());
            let written = self.inner.set(record, ttl).await;
            if let Some(data) = finished {
                self.sink.publish(TASK_FINISHED_TYPE, data);
            }
            written
        })
    }

    fn get(&self, id: &str) -> StoreFuture<'_, Option<TaskRecord>> {
        self.inner.get(id)
    }

    fn list(&self) -> StoreFuture<'_, Vec<TaskRecord>> {
        self.inner.list()
    }

    fn delete(&self, id: &str) -> StoreFuture<'_, ()> {
        self.inner.delete(id)
    }

    fn shutdown(&self) -> StoreFuture<'_, ()> {
        self.inner.shutdown()
    }
}
