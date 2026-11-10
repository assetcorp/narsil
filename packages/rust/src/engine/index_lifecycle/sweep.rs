use std::sync::{Arc, Condvar, Mutex, Weak};
use std::thread::JoinHandle;
use std::time::Duration;

use super::constants::{MAX_SWEEP_INTERVAL_MS, MIN_SWEEP_INTERVAL_MS};
use super::{close_index, enforce_limits};
use crate::engine::EngineInner;

/// The thread that closes idle indexes and keeps the open indexes within the lifecycle limits.
#[derive(Default)]
pub(crate) struct Sweeper {
    stopped: Arc<(Mutex<bool>, Condvar)>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

fn sweep(engine: &EngineInner, idle_timeout_ms: Option<u64>) {
    if let Some(timeout) = idle_timeout_ms {
        let now = engine.lifecycle.now_ms();
        for index in engine.index_list() {
            let idle_for = now.saturating_sub(index.residency.last_access_ms());
            if idle_for >= timeout {
                let _ = close_index(engine, &index.name, true);
            }
        }
    }
    enforce_limits(engine, None);
}

fn interval(idle_timeout_ms: Option<u64>) -> Duration {
    let requested = idle_timeout_ms.map_or(MAX_SWEEP_INTERVAL_MS, |timeout| timeout / 2);
    Duration::from_millis(requested.clamp(MIN_SWEEP_INTERVAL_MS, MAX_SWEEP_INTERVAL_MS))
}

impl Sweeper {
    /// Starts the thread where the engine has lifecycle limits and durability, holding the engine weakly so that
    /// dropping the engine ends it.
    pub(crate) fn start(&self, engine: &Arc<EngineInner>) {
        let Some(limits) = engine.lifecycle.limits else {
            return;
        };
        if engine.durable.is_none() {
            return;
        }
        let weak: Weak<EngineInner> = Arc::downgrade(engine);
        let stopped = Arc::clone(&self.stopped);
        let every = interval(limits.idle_timeout_ms);
        let spawned = std::thread::Builder::new()
            .name("narsil-lifecycle".to_string())
            .spawn(move || {
                loop {
                    {
                        let (lock, wake) = &*stopped;
                        let state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                        let (state, _) = wake
                            .wait_timeout_while(state, every, |stopped| !*stopped)
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        if *state {
                            return;
                        }
                    }
                    let Some(engine) = weak.upgrade() else {
                        return;
                    };
                    if engine.guard_shutdown().is_err() {
                        return;
                    }
                    sweep(&engine, limits.idle_timeout_ms);
                }
            });
        if let (Ok(handle), Ok(mut thread)) = (spawned, self.thread.lock()) {
            *thread = Some(handle);
        }
    }

    /// Stops the thread and waits for a sweep that runs to finish.
    pub(crate) fn stop(&self) {
        {
            let (lock, wake) = &*self.stopped;
            let mut stopped = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            *stopped = true;
            wake.notify_all();
        }
        let handle = self.thread.lock().ok().and_then(|mut thread| thread.take());
        if let Some(handle) = handle
            && handle.thread().id() != std::thread::current().id()
        {
            let _ = handle.join();
        }
    }
}

impl Drop for Sweeper {
    fn drop(&mut self) {
        self.stop();
    }
}
