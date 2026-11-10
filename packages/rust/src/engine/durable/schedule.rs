use std::sync::{Arc, Condvar, Mutex, Weak};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::backing::Backing;
use super::checkpoint::write_checkpoint;
use crate::engine::EngineInner;
use crate::engine::events::NarsilEvent;
use crate::engine::index::IndexState;
use crate::engine::sync::constants::HISTORY_SWEEP_INTERVAL_MS;
use crate::engine::sync::retention::enforce_history_limits;

#[derive(Default)]
struct Signal {
    requested: bool,
    stopped: bool,
}

/// The thread that writes each durable index's checkpoints, so that a write never waits for one.
pub(crate) struct CheckpointSchedule {
    signal: Arc<(Mutex<Signal>, Condvar)>,
    thread: Mutex<Option<JoinHandle<()>>>,
    interval: Option<Duration>,
    mutation_threshold: u64,
}

fn due(index: &IndexState, threshold: u64, interval_elapsed: bool) -> bool {
    let Some(log) = index.log() else {
        return false;
    };
    match log.backing() {
        Backing::Log(store) => store.checkpoint_due(&index.name).unwrap_or(false),
        Backing::Snapshot(_) => {
            let unsaved = log.unsaved_writes();
            unsaved >= threshold || (interval_elapsed && unsaved > 0)
        }
    }
}

fn checkpoint_due_indexes(engine: &EngineInner, threshold: u64, interval_elapsed: bool) {
    for index in engine.index_list() {
        if !due(&index, threshold, interval_elapsed) {
            continue;
        }
        if let Some(log) = index.log()
            && let Err(error) = write_checkpoint(&index, log, None)
            && !index.is_retired()
        {
            engine.events.emit(NarsilEvent::DurabilityError {
                index_name: index.name.clone(),
                error,
            });
        }
    }
}

impl CheckpointSchedule {
    pub(crate) fn new(interval_ms: u64, mutation_threshold: u64) -> CheckpointSchedule {
        CheckpointSchedule {
            signal: Arc::new((Mutex::new(Signal::default()), Condvar::new())),
            thread: Mutex::new(None),
            interval: (interval_ms > 0).then(|| Duration::from_millis(interval_ms)),
            mutation_threshold: mutation_threshold.max(1),
        }
    }

    /// Starts the thread, which holds the engine weakly so that dropping the engine ends it.
    pub(crate) fn start(&self, engine: &Arc<EngineInner>) {
        let weak: Weak<EngineInner> = Arc::downgrade(engine);
        let signal = Arc::clone(&self.signal);
        let interval = self.interval;
        let threshold = self.mutation_threshold;
        let spawned = std::thread::Builder::new()
            .name("narsil-checkpoint".to_string())
            .spawn(move || {
                let mut next_tick = interval.map(|every| Instant::now() + every);
                let sweep_every = Duration::from_millis(HISTORY_SWEEP_INTERVAL_MS);
                let mut next_sweep = Instant::now() + sweep_every;
                loop {
                    let (lock, wake) = &*signal;
                    let mut state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                    while !state.requested && !state.stopped {
                        let now = Instant::now();
                        let deadline = next_tick.map_or(next_sweep, |tick| tick.min(next_sweep));
                        if deadline <= now {
                            break;
                        }
                        state = wake
                            .wait_timeout(state, deadline - now)
                            .map(|(state, _)| state)
                            .unwrap_or_else(|poisoned| poisoned.into_inner().0);
                    }
                    if state.stopped {
                        return;
                    }
                    state.requested = false;
                    drop(state);
                    let interval_elapsed = next_tick.is_some_and(|tick| tick <= Instant::now());
                    if interval_elapsed {
                        next_tick = interval.map(|every| Instant::now() + every);
                    }
                    let sweep_elapsed = next_sweep <= Instant::now();
                    if sweep_elapsed {
                        next_sweep = Instant::now() + sweep_every;
                    }
                    let Some(engine) = weak.upgrade() else {
                        return;
                    };
                    checkpoint_due_indexes(&engine, threshold, interval_elapsed);
                    enforce_history_limits(&engine, sweep_elapsed);
                }
            });
        if let (Ok(handle), Ok(mut thread)) = (spawned, self.thread.lock()) {
            *thread = Some(handle);
        }
    }

    /// Wakes the thread once a write has taken an index's unsaved writes to the threshold.
    pub(crate) fn after_write(&self, index: &IndexState) {
        if !due(index, self.mutation_threshold, false) {
            return;
        }
        let (lock, wake) = &*self.signal;
        let mut state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        state.requested = true;
        wake.notify_one();
    }

    /// Wakes the thread for one pass, so that it applies the history limits of an index whose checkpoint, written
    /// on another thread, moved log segments into history.
    pub(crate) fn request_pass(&self) {
        let (lock, wake) = &*self.signal;
        let mut state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        state.requested = true;
        wake.notify_one();
    }

    /// Stops the thread and waits for a checkpoint that it is writing to finish.
    pub(crate) fn stop(&self) {
        {
            let (lock, wake) = &*self.signal;
            let mut state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            state.stopped = true;
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
