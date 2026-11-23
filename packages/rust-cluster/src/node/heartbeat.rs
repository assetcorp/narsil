use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;
use tokio::task::JoinHandle;

use super::member::NodeInner;
use crate::controller::lock;
use crate::coordinator::NodeRegistration;
use crate::error::{ClusterResult, codes};
use crate::memory::NodeMemory;

const PARTITION_BYTES_FIELD: &str = "partitionBytes";

pub(super) struct Heartbeat {
    stop: watch::Sender<bool>,
    task: JoinHandle<()>,
}

async fn full_changed(memory: Option<&Arc<NodeMemory>>) {
    match memory {
        Some(memory) => memory.full_changed().await,
        None => std::future::pending().await,
    }
}

impl NodeInner {
    pub(super) async fn current_registration(&self) -> NodeRegistration {
        match self.memory() {
            Some(memory) => memory.current_registration(&self.registration).await,
            None => self.registration.clone(),
        }
    }

    pub(super) async fn write_registration(&self) -> ClusterResult<()> {
        let registration = self.current_registration().await;
        let Err(error) = self.coordinator.register_node(&registration).await else {
            return Ok(());
        };
        if error.code() != codes::CONFIG_INVALID
            || registration.extra.get(PARTITION_BYTES_FIELD).is_none()
        {
            return Err(error);
        }
        let mut smaller = registration;
        smaller.extra.remove(PARTITION_BYTES_FIELD);
        self.coordinator.register_node(&smaller).await?;
        Err(error)
    }

    pub(super) fn start_heartbeat(self: &Arc<Self>) {
        let (stop, mut stopped) = watch::channel(false);
        let inner = Arc::downgrade(self);
        let memory = self.memory();
        let every = Duration::from_millis(self.heartbeat_interval_ms);
        let task = tokio::spawn(async move {
            let mut ticks = tokio::time::interval(every);
            ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            ticks.tick().await;
            loop {
                tokio::select! {
                    _ = ticks.tick() => {}
                    _ = full_changed(memory.as_ref()) => {}
                    _ = stopped.wait_for(|stopped| *stopped) => return,
                }
                let Some(inner) = inner.upgrade() else {
                    return;
                };
                if let Err(error) = inner.write_registration().await {
                    inner.report(&error);
                }
            }
        });
        if let Some(previous) = lock(&self.heartbeat).replace(Heartbeat { stop, task }) {
            previous.task.abort();
        }
    }

    pub(super) async fn stop_heartbeat(&self) {
        let Some(heartbeat) = lock(&self.heartbeat).take() else {
            return;
        };
        let _ = heartbeat.stop.send(true);
        let _ = heartbeat.task.await;
    }
}
