use std::sync::Arc;

use super::store::TaskStore;

pub(crate) struct TaskRegistry {
    store: Arc<dyn TaskStore>,
    instance_id: String,
    max_concurrent: u64,
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
        }
    }

    pub(crate) async fn reconcile(&self) {
        let _ = (&self.instance_id, self.max_concurrent);
    }

    pub(crate) async fn shutdown(&self) {
        let _ = self.store.shutdown().await;
    }
}
