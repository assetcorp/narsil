use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use tokio::sync::{Notify, watch};

pub(crate) struct ByteBudget {
    limit: u64,
    used: Mutex<u64>,
    freed: watch::Sender<u64>,
}

impl ByteBudget {
    pub(crate) fn new(limit: u64) -> ByteBudget {
        ByteBudget {
            limit,
            used: Mutex::new(0),
            freed: watch::Sender::new(0),
        }
    }

    fn used(&self) -> MutexGuard<'_, u64> {
        self.used
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn take(&self, bytes: u64) -> bool {
        let mut used = self.used();
        let after = used.saturating_add(bytes);
        if *used > 0 && after > self.limit {
            return false;
        }
        *used = after;
        true
    }

    pub(crate) fn give(&self, bytes: u64) {
        if bytes == 0 {
            return;
        }
        {
            let mut used = self.used();
            *used = used.saturating_sub(bytes);
        }
        self.freed
            .send_modify(|generation| *generation = generation.wrapping_add(1));
    }

    pub(crate) fn watch_freed(&self) -> watch::Receiver<u64> {
        self.freed.subscribe()
    }
}

#[derive(Default)]
pub(crate) struct ConnectionTracker {
    running: Mutex<usize>,
    idle: Notify,
}

pub(crate) struct TrackedConnection {
    tracker: Arc<ConnectionTracker>,
}

impl ConnectionTracker {
    fn running(&self) -> MutexGuard<'_, usize> {
        self.running
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn enter(self: &Arc<Self>) -> TrackedConnection {
        *self.running() += 1;
        TrackedConnection {
            tracker: Arc::clone(self),
        }
    }

    pub(crate) async fn wait_idle(&self, deadline: Duration) {
        let drained = async {
            loop {
                let notified = self.idle.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if *self.running() == 0 {
                    return;
                }
                notified.await;
            }
        };
        let _ = tokio::time::timeout(deadline, drained).await;
    }
}

impl Drop for TrackedConnection {
    fn drop(&mut self) {
        let mut running = self.tracker.running();
        *running = running.saturating_sub(1);
        if *running == 0 {
            self.tracker.idle.notify_waiters();
        }
    }
}
