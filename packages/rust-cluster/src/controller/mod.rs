mod allocation;
mod analysis_change;
mod analysis_metadata;
mod bootstrap;
mod departures;
mod election;
mod event_loop;
mod holder_retry;
mod insync;
mod messages;
mod metadata;
mod placement;
mod queue;
mod rebalance;
mod recovery;
mod replication_factor;
mod resign;
mod settings;
mod state;
mod table;
mod teardown;
mod unplaceable_index;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::task::JoinHandle;

use self::queue::TaskQueues;
use self::state::LoopState;
use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::{ClusterError, ClusterResult};
use crate::message::TransportMessage;
use crate::transport::{NodeTransport, Respond};

pub(crate) use self::analysis_metadata::{
    IndexMetadataSnapshot, PendingAnalysis, metadata_with_pending_analysis,
    metadata_without_pending_analysis, read_index_metadata_snapshot,
};
pub(crate) use self::messages::is_controller_message;
pub(crate) use self::metadata::{
    IndexMetadata, index_metadata, metadata_key, records_previous_documents, stored_index_metadata,
};
pub(crate) use self::settings::{previous_documents_recorded, stored_settings_readable};
pub(crate) use self::table::{belongs_to_another_index, stored_table};

pub(crate) type ControllerErrorHandler = Arc<dyn Fn(&str, &ClusterError) + Send + Sync>;

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_millis() as f64)
}

pub(crate) struct ControllerConfig {
    pub(crate) node_id: String,
    pub(crate) coordinator: Arc<EtcdCoordinator>,
    pub(crate) transport: Arc<dyn NodeTransport>,
    pub(crate) lease_ttl_ms: u64,
    pub(crate) standby_retry_ms: u64,
    pub(crate) node_left_delay_ms: u64,
    pub(crate) on_error: Option<ControllerErrorHandler>,
    pub(crate) on_election_error: Option<ControllerErrorHandler>,
}

#[derive(Default)]
struct ElectionTimers {
    renewal: Option<JoinHandle<()>>,
    standby: Option<JoinHandle<()>>,
}

impl ElectionTimers {
    fn clear_standby(&mut self) {
        if let Some(handle) = self.standby.take() {
            handle.abort();
        }
    }

    fn clear(&mut self) {
        if let Some(handle) = self.renewal.take() {
            handle.abort();
        }
        self.clear_standby();
    }
}

pub(crate) struct Inner {
    config: ControllerConfig,
    active: AtomicBool,
    stopped: AtomicBool,
    timers: Mutex<ElectionTimers>,
    state: Mutex<LoopState>,
    schema_queues: Arc<TaskQueues>,
    insync_queue: Arc<TaskQueues>,
    sequence: AtomicU64,
}

impl Inner {
    pub(crate) fn is_active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }

    fn coordinator(&self) -> &EtcdCoordinator {
        &self.config.coordinator
    }

    fn node_id(&self) -> &str {
        &self.config.node_id
    }

    fn next_sequence(&self) -> u64 {
        self.sequence.fetch_add(1, Ordering::Relaxed)
    }

    fn report(&self, index_name: &str, error: &ClusterError) {
        if let Some(on_error) = &self.config.on_error {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                on_error(index_name, error);
            }));
        }
    }

    fn clear_event_loop(&self) {
        let watches = lock(&self.state).clear();
        for watch in watches {
            watch.stop();
        }
    }

    fn is_listening(&self) -> bool {
        self.is_active() && lock(&self.state).listening
    }
}

pub(crate) struct Controller {
    inner: Arc<Inner>,
}

impl Controller {
    pub(crate) fn new(config: ControllerConfig) -> Controller {
        Controller {
            inner: Arc::new(Inner {
                config,
                active: AtomicBool::new(false),
                stopped: AtomicBool::new(false),
                timers: Mutex::new(ElectionTimers::default()),
                state: Mutex::new(LoopState::default()),
                schema_queues: Arc::new(TaskQueues::default()),
                insync_queue: Arc::new(TaskQueues::default()),
                sequence: AtomicU64::new(0),
            }),
        }
    }

    pub(crate) fn is_active(&self) -> bool {
        self.inner.is_active()
    }

    pub(crate) fn is_listening(&self) -> bool {
        self.inner.is_listening()
    }

    pub(crate) async fn start(&self) -> ClusterResult<()> {
        self.inner.stopped.store(false, Ordering::Release);
        lock(&self.inner.timers).clear_standby();
        match self.inner.stand_for_election().await {
            Ok(()) => Ok(()),
            Err(error) => {
                self.inner.stand_by();
                Err(error)
            }
        }
    }

    pub(crate) async fn stop(&self) {
        self.inner.stopped.store(true, Ordering::Release);
        lock(&self.inner.timers).clear();
        self.inner.clear_event_loop();
        if self.inner.active.swap(false, Ordering::AcqRel) {
            let _ = self
                .inner
                .coordinator()
                .release_lease(crate::constants::CONTROLLER_LEASE_KEY)
                .await;
        }
    }

    pub(crate) async fn handle(&self, message: TransportMessage, respond: Respond) {
        messages::handle_message(&self.inner, message, respond).await;
    }
}
