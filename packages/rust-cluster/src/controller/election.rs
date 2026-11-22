use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use super::{Inner, lock};
use crate::constants::{CONTROLLER_LEASE_KEY, LEASE_RENEWALS_PER_TTL};
use crate::error::ClusterResult;
use crate::transport::BoxFuture;

impl Inner {
    pub(super) fn stand_by(self: &Arc<Self>) {
        if self.stopped.load(Ordering::Acquire) {
            return;
        }
        let inner = Arc::clone(self);
        let retry = Duration::from_millis(self.config.standby_retry_ms);
        let mut timers = lock(&self.timers);
        timers.clear_standby();
        timers.standby = Some(tokio::spawn(async move {
            tokio::time::sleep(retry).await;
            lock(&inner.timers).standby = None;
            Arc::clone(&inner).run_election().await;
        }));
    }

    pub(super) fn step_down(self: &Arc<Self>) {
        if !self.active.swap(false, Ordering::AcqRel) {
            return;
        }
        lock(&self.timers).clear();
        self.clear_event_loop();
        self.stand_by();
    }

    fn start_renewal(self: &Arc<Self>) {
        let interval_ms = (self.config.lease_ttl_ms / u64::from(LEASE_RENEWALS_PER_TTL)).max(1);
        let inner = Arc::clone(self);
        let renewal = tokio::spawn(async move {
            let mut ticks = tokio::time::interval(Duration::from_millis(interval_ms));
            ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            ticks.tick().await;
            loop {
                ticks.tick().await;
                let renewed = inner
                    .coordinator()
                    .renew_lease(CONTROLLER_LEASE_KEY, inner.node_id())
                    .await;
                if !matches!(renewed, Ok(true)) {
                    inner.step_down();
                    return;
                }
            }
        });
        let mut timers = lock(&self.timers);
        if let Some(previous) = timers.renewal.replace(renewal) {
            previous.abort();
        }
    }

    async fn become_active(self: &Arc<Self>) -> ClusterResult<()> {
        if self.active.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        self.start_renewal();
        if let Err(error) = self.start_event_loop().await {
            self.active.store(false, Ordering::Release);
            lock(&self.timers).clear();
            let _ = self.coordinator().release_lease(CONTROLLER_LEASE_KEY).await;
            return Err(error);
        }
        Ok(())
    }

    pub(super) async fn stand_for_election(self: &Arc<Self>) -> ClusterResult<()> {
        if self.stopped.load(Ordering::Acquire) {
            return Ok(());
        }
        let acquired = self
            .coordinator()
            .acquire_lease(
                CONTROLLER_LEASE_KEY,
                self.node_id(),
                self.config.lease_ttl_ms,
            )
            .await?;
        if self.stopped.load(Ordering::Acquire) {
            if acquired {
                self.coordinator()
                    .release_lease(CONTROLLER_LEASE_KEY)
                    .await?;
            }
            return Ok(());
        }
        if acquired {
            return self.become_active().await;
        }
        self.stand_by();
        Ok(())
    }

    fn run_election(self: Arc<Self>) -> BoxFuture<'static, ()> {
        Box::pin(async move {
            if let Err(error) = self.stand_for_election().await {
                if let Some(on_election_error) = &self.config.on_election_error {
                    let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
                        on_election_error("", &error);
                    }));
                }
                self.stand_by();
            }
        })
    }
}
