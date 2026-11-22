use std::sync::Arc;

use narsil::Value;
use tokio::sync::watch;

use super::WatcherContext;
use super::state::{Abort, BootstrapSlot, PartitionKey, Tracked};
use crate::allocator::INITIALISING;
use crate::constants::{
    BOOTSTRAP_MAX_RETRIES, BOOTSTRAP_RESTART_DELAY_MS, BOOTSTRAP_RETRY_BASE_MS,
    BOOTSTRAP_RETRY_MAX_MS,
};
use crate::controller::lock;
use crate::error::{ClusterError, codes};

const JITTER_FLOOR: f64 = 0.5;
const JITTER_SPAN: f64 = 0.5;

fn random_fraction() -> f64 {
    let mut bytes = [0u8; 8];
    if getrandom::fill(&mut bytes).is_err() {
        return 1.0;
    }
    (u64::from_le_bytes(bytes) >> 11) as f64 / (1u64 << 53) as f64
}

fn backoff_ms(retry: u32) -> u64 {
    let doubled = BOOTSTRAP_RETRY_BASE_MS.saturating_mul(1u64 << retry.min(32));
    let capped = doubled.min(BOOTSTRAP_RETRY_MAX_MS) as f64;
    (capped * (JITTER_FLOOR + random_fraction() * JITTER_SPAN)).floor() as u64
}

fn bootstrap_failure(
    key: &PartitionKey,
    message: String,
    cause: Option<&ClusterError>,
) -> ClusterError {
    let mut failure = ClusterError::new(codes::NODE_BOOTSTRAP_FAILED, message)
        .with_detail("indexName", Value::String(key.0.clone()))
        .with_detail("partitionId", Value::from(key.1));
    if let Some(cause) = cause {
        failure = failure
            .with_detail("cause", Value::String(cause.message().to_string()))
            .with_detail("innerCode", Value::String(cause.code().to_string()));
    }
    failure
}

impl WatcherContext {
    pub(super) fn start_bootstrap(self: &Arc<Self>, key: PartitionKey, primary_term: f64) {
        let mut state = lock(&self.state);
        if state.stopped {
            return;
        }
        state.abort_bootstrap(&key);
        state.next_bootstrap_id += 1;
        let id = state.next_bootstrap_id;
        let (abort, aborted) = watch::channel(false);
        let task =
            tokio::spawn(Arc::clone(self).run_bootstrap(key.clone(), id, Abort::new(aborted)));
        state.tracked.insert(
            key.clone(),
            Tracked {
                is_primary: true,
                primary_term,
            },
        );
        state.bootstraps.insert(
            key,
            BootstrapSlot {
                id,
                abort,
                task: Some(task),
            },
        );
    }

    async fn run_bootstrap(self: Arc<Self>, key: PartitionKey, id: u64, mut abort: Abort) {
        let succeeded = self.bootstrap_partition(&key, &mut abort).await;
        let restart = {
            let mut state = lock(&self.state);
            let current = state.bootstraps.get(&key).is_some_and(|slot| slot.id == id);
            if current {
                state.bootstraps.remove(&key);
            }
            let restart = !succeeded && current && !state.stopped;
            if restart {
                state.tracked.remove(&key);
            }
            restart
        };
        if restart {
            self.restart_while_primary_initialising(key).await;
        }
    }

    async fn attempt_once(self: &Arc<Self>, key: &PartitionKey, abort: &mut Abort) -> bool {
        match abort.unless_aborted(self.prepare_primary(key)).await {
            None => false,
            Some(Ok(prepared)) => prepared,
            Some(Err(error)) => {
                let message = format!("Bootstrap sync failed for {}:{}", key.0, key.1);
                self.report(&bootstrap_failure(key, message, Some(&error)));
                false
            }
        }
    }

    async fn bootstrap_partition(self: &Arc<Self>, key: &PartitionKey, abort: &mut Abort) -> bool {
        for attempt in 0..=BOOTSTRAP_MAX_RETRIES {
            if abort.is_aborted() {
                return false;
            }
            let prepared = self.attempt_once(key, abort).await;
            if abort.is_aborted() {
                return false;
            }
            if prepared {
                if !self.awaits_bootstrap_report(key).await {
                    return true;
                }
                return self.report_with_retries(key, abort).await;
            }
            if attempt < BOOTSTRAP_MAX_RETRIES && !abort.pause(backoff_ms(attempt)).await {
                return false;
            }
        }
        false
    }

    async fn report_with_retries(self: &Arc<Self>, key: &PartitionKey, abort: &mut Abort) -> bool {
        let mut last_failure = None;
        for attempt in 0..=BOOTSTRAP_MAX_RETRIES {
            if abort.is_aborted() {
                return false;
            }
            if attempt > 0 && !self.awaits_bootstrap_report(key).await {
                return true;
            }
            match abort
                .unless_aborted(self.report_bootstrap_complete(key))
                .await
            {
                None => return false,
                Some(Ok(true)) => return true,
                Some(Ok(false)) => last_failure = None,
                Some(Err(error)) => last_failure = Some(error),
            }
            if !self.awaits_bootstrap_report(key).await {
                return true;
            }
            if attempt < BOOTSTRAP_MAX_RETRIES && !abort.pause(backoff_ms(attempt)).await {
                return false;
            }
        }
        if abort.is_aborted() {
            return false;
        }
        let attempts = BOOTSTRAP_MAX_RETRIES + 1;
        let message = format!(
            "Failed to report bootstrap completion for {}:{} after {attempts} attempts",
            key.0, key.1
        );
        self.report(&bootstrap_failure(key, message, last_failure.as_ref()));
        false
    }

    async fn restart_while_primary_initialising(self: &Arc<Self>, key: PartitionKey) {
        let mut stopping = Abort::new(self.stopping.subscribe());
        loop {
            if !stopping.pause(BOOTSTRAP_RESTART_DELAY_MS).await {
                return;
            }
            let table = match self.live_table(&key.0).await {
                Ok(table) => table,
                Err(error) => {
                    if !stopping.is_aborted() {
                        self.report(&error);
                    }
                    continue;
                }
            };
            let Some(assignment) = table
                .as_ref()
                .and_then(|table| table.assignments.get(f64::from(key.1)))
            else {
                return;
            };
            if !assignment.is_primary(&self.node_id) || assignment.state != INITIALISING {
                return;
            }
            if lock(&self.state).bootstraps.contains_key(&key) {
                return;
            }
            self.start_bootstrap(key, assignment.primary_term);
            return;
        }
    }
}
