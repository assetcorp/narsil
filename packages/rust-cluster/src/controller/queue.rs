use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tokio::task::JoinHandle;

use super::lock;

#[derive(Default)]
pub(crate) struct TaskQueues {
    chains: Mutex<HashMap<String, (u64, JoinHandle<()>)>>,
    next: AtomicU64,
}

impl TaskQueues {
    pub(crate) fn enqueue<F>(self: &Arc<Self>, key: &str, task: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let sequence = self.next.fetch_add(1, Ordering::Relaxed);
        let mut chains = lock(&self.chains);
        let previous = chains.remove(key).map(|(_, handle)| handle);
        let queues = Arc::clone(self);
        let owned_key = key.to_string();
        let handle = tokio::spawn(async move {
            if let Some(previous) = previous {
                let _ = previous.await;
            }
            task.await;
            let mut chains = lock(&queues.chains);
            if chains
                .get(&owned_key)
                .is_some_and(|(queued, _)| *queued == sequence)
            {
                chains.remove(&owned_key);
            }
        });
        chains.insert(key.to_string(), (sequence, handle));
    }
}
