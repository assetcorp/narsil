use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};

use narsil::Value;
use tokio::sync::watch;

use super::config::{ClusterNodeConfig, report_failure};
use super::heartbeat::Heartbeat;
use super::join::{
    refuse_controller_on_another_major_version, wait_for_earlier_registration_to_lapse,
};
use super::not_ready::{answer_ping, not_ready};
use crate::controller::{
    Controller, ControllerConfig, ControllerErrorHandler, is_controller_message, lock,
};
use crate::coordinator::NodeRegistration;
use crate::coordinator::etcd::EtcdCoordinator;
use crate::data::DataRole;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::memory::{NodeMemory, NodeMemorySettings};
use crate::message::{TransportMessage, is_specified_message_type, message_types, refusal};
use crate::node::NodeErrorHandler;
use crate::routing::WriteRouter;
use crate::transport::{BoxFuture, Listening, NodeTransport, Respond, listen_handler};

const CONTROLLER_ROLE: &str = "controller";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Phase {
    Idle,
    Joining,
    Active,
    Shutdown,
}

pub(super) struct NodeInner {
    pub(super) coordinator: Arc<EtcdCoordinator>,
    transport: Arc<dyn NodeTransport>,
    pub(super) registration: NodeRegistration,
    pub(super) heartbeat_interval_ms: u64,
    in_flight_write_fraction: f64,
    on_error: Option<NodeErrorHandler>,
    pub(super) controller: Option<Controller>,
    pub(super) data: Option<DataRole>,
    pub(super) phase: Mutex<Phase>,
    pub(super) lifecycle: tokio::sync::Mutex<()>,
    pub(super) stopping: watch::Sender<bool>,
    pub(super) joined: AtomicBool,
    pub(super) registered: AtomicBool,
    controller_standing: AtomicBool,
    pub(super) heartbeat: Mutex<Option<Heartbeat>>,
    listening: Mutex<Option<Listening>>,
    router: Mutex<Option<Arc<WriteRouter>>>,
    memory: Mutex<Option<Arc<NodeMemory>>>,
}

fn not_controller(node_id: &str) -> ClusterError {
    ClusterError::new(
        codes::NODE_NOT_CONTROLLER,
        format!("Node '{node_id}' holds no controller lease, so it answers no controller message"),
    )
    .with_detail("nodeId", Value::String(node_id.to_string()))
}

pub(super) fn node_error(code: &str, message: String, node_id: &str) -> ClusterError {
    ClusterError::new(code, message).with_detail("nodeId", Value::String(node_id.to_string()))
}

impl NodeInner {
    pub(super) fn new(config: ClusterNodeConfig) -> NodeInner {
        let ClusterNodeConfig {
            coordinator,
            transport,
            registration,
            controller: timing,
            data,
            heartbeat_interval_ms,
            in_flight_write_fraction,
            on_error,
        } = config;
        let controller = registration
            .roles
            .iter()
            .any(|role| role == CONTROLLER_ROLE)
            .then(|| {
                let index_errors = on_error.clone().map(|handler| -> ControllerErrorHandler {
                    Arc::new(move |_index_name: &str, error: &ClusterError| handler(error))
                });
                Controller::new(ControllerConfig {
                    node_id: registration.node_id.clone(),
                    coordinator: Arc::clone(&coordinator),
                    transport: Arc::clone(&transport),
                    lease_ttl_ms: timing.lease_ttl_ms,
                    standby_retry_ms: timing.standby_retry_ms,
                    node_left_delay_ms: timing.node_left_delay_ms,
                    on_error: index_errors.clone(),
                    on_election_error: index_errors,
                })
            });
        let data = data.map(|settings| {
            DataRole::new(
                registration.node_id.clone(),
                Arc::clone(&coordinator),
                settings,
                on_error.clone(),
            )
        });
        NodeInner {
            coordinator,
            transport,
            registration,
            heartbeat_interval_ms,
            in_flight_write_fraction,
            on_error,
            controller,
            data,
            phase: Mutex::new(Phase::Idle),
            lifecycle: tokio::sync::Mutex::new(()),
            stopping: watch::Sender::new(false),
            joined: AtomicBool::new(false),
            registered: AtomicBool::new(false),
            controller_standing: AtomicBool::new(false),
            heartbeat: Mutex::new(None),
            listening: Mutex::new(None),
            router: Mutex::new(None),
            memory: Mutex::new(None),
        }
    }

    pub(super) fn has_backup_store(&self) -> bool {
        false
    }

    pub(super) fn memory(&self) -> Option<Arc<NodeMemory>> {
        lock(&self.memory).clone()
    }

    async fn start_memory_reporting(&self) -> ClusterResult<()> {
        let (measure, partition_sizes) = match &self.data {
            Some(data) => {
                let (measure, sizes) = data.memory_sources()?;
                (measure, Some(sizes))
            }
            None => {
                let measure: crate::memory::MemorySource =
                    Arc::new(narsil::replication::read_process_memory);
                (measure, None)
            }
        };
        let memory = Arc::new(NodeMemory::new(NodeMemorySettings {
            node_id: self.node_id().to_string(),
            coordinator: Arc::clone(&self.coordinator),
            measure,
            partition_sizes,
            in_flight_write_fraction: self.in_flight_write_fraction,
        }));
        let previous = lock(&self.memory).replace(Arc::clone(&memory));
        if let Some(previous) = previous {
            previous.stop().await;
        }
        memory.start().await
    }

    async fn stop_memory_reporting(&self) {
        let memory = lock(&self.memory).take();
        if let Some(memory) = memory {
            memory.stop().await;
        }
    }

    pub(super) fn router(&self) -> ClusterResult<Arc<WriteRouter>> {
        lock(&self.router).clone().ok_or_else(|| {
            let node_id = self.node_id();
            node_error(
                codes::NODE_NOT_JOINED,
                format!("Node '{node_id}' has not joined the cluster, so it routes no write"),
                node_id,
            )
        })
    }

    async fn start_routing(&self) -> ClusterResult<()> {
        let local = match &self.data {
            Some(data) => Some(data.primary_writes()?),
            None => None,
        };
        let router = WriteRouter::start(
            self.node_id().to_string(),
            Arc::clone(&self.coordinator),
            Arc::clone(&self.transport),
            local,
            self.memory(),
        )
        .await?;
        if let Some(previous) = lock(&self.router).replace(router) {
            previous.stop();
        }
        Ok(())
    }

    pub(super) fn node_id(&self) -> &str {
        &self.registration.node_id
    }

    pub(super) fn report(&self, error: &ClusterError) {
        report_failure(self.on_error.as_ref(), error);
    }

    fn is_stopping(&self) -> bool {
        *self.stopping.borrow()
    }

    async fn answer(&self, message: TransportMessage, respond: Respond) {
        let node_id = self.node_id();
        if message.message_type == message_types::CLUSTER_PING {
            return respond.send(answer_ping(&message, node_id)).await;
        }
        let joined = self.joined.load(Ordering::Acquire);
        if is_controller_message(&message.message_type) {
            return match &self.controller {
                Some(controller) if controller.is_listening() => {
                    controller.handle(message, respond).await
                }
                _ if !joined => {
                    respond
                        .send(refusal(&message, node_id, &not_ready(node_id)))
                        .await
                }
                _ => {
                    respond
                        .send(refusal(&message, node_id, &not_controller(node_id)))
                        .await
                }
            };
        }
        let answered = DataRole::answers(&message.message_type);
        match &self.data {
            Some(data) if joined && answered => data.answer(message, respond).await,
            _ if joined && !is_specified_message_type(&message.message_type) => {}
            _ => {
                respond
                    .send(refusal(&message, node_id, &not_ready(node_id)))
                    .await
            }
        }
    }

    async fn stand_early(&self) {
        let Some(controller) = &self.controller else {
            return;
        };
        if self.controller_standing.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Err(error) = controller.start().await {
            self.report(&error);
        }
    }

    async fn holds_registration(&self) -> ClusterResult<bool> {
        let registered = self.coordinator.list_nodes().await?;
        Ok(registered.iter().any(|node| node.node_id == self.node_id()))
    }

    async fn wait_until_free_to_register(self: &Arc<Self>) -> ClusterResult<()> {
        let mut stopping = self.stopping.subscribe();
        let Some(data) = &self.data else {
            return Ok(());
        };
        let inner = Arc::clone(self);
        let stand_for_election = move || -> BoxFuture<'static, ()> {
            let inner = Arc::clone(&inner);
            Box::pin(async move { inner.stand_early().await })
        };
        loop {
            data.wait_for_lost_copies(&mut stopping, &stand_for_election)
                .await?;
            if !self.holds_registration().await? {
                return Ok(());
            }
            wait_for_earlier_registration_to_lapse(
                &self.coordinator,
                self.node_id(),
                &mut stopping,
            )
            .await?;
        }
    }

    async fn listen(self: &Arc<Self>) -> ClusterResult<()> {
        let inner: Weak<NodeInner> = Arc::downgrade(self);
        let fallback_id = self.node_id().to_string();
        let handler = listen_handler(move |message: TransportMessage, respond: Respond| {
            let inner = inner.upgrade();
            let fallback_id = fallback_id.clone();
            async move {
                match inner {
                    Some(inner) => inner.answer(message, respond).await,
                    None => {
                        respond
                            .send(refusal(&message, &fallback_id, &not_ready(&fallback_id)))
                            .await
                    }
                }
                Ok(())
            }
        });
        let listening = self.transport.listen(handler).await?;
        if let Some(previous) = lock(&self.listening).replace(listening) {
            previous.stop();
        }
        Ok(())
    }

    fn abort_if_stopping(&self) -> ClusterResult<()> {
        if !self.is_stopping() {
            return Ok(());
        }
        let node_id = self.node_id();
        Err(node_error(
            codes::NODE_NOT_JOINED,
            format!("Node '{node_id}' shut down while it joined the cluster"),
            node_id,
        ))
    }

    pub(super) async fn join(self: &Arc<Self>) -> ClusterResult<()> {
        self.listen().await?;
        refuse_controller_on_another_major_version(&self.coordinator, &self.registration).await?;
        let mut stopping = self.stopping.subscribe();
        wait_for_earlier_registration_to_lapse(&self.coordinator, self.node_id(), &mut stopping)
            .await?;
        self.abort_if_stopping()?;
        if let Some(data) = &self.data {
            data.open().await?;
            self.abort_if_stopping()?;
            self.wait_until_free_to_register().await?;
            self.abort_if_stopping()?;
        }
        self.start_memory_reporting().await?;
        let registration = self.current_registration().await;
        self.coordinator.register_node(&registration).await?;
        self.registered.store(true, Ordering::Release);
        self.start_heartbeat();
        if let Some(data) = &self.data {
            data.follow_allocations(Arc::clone(&self.transport), self.memory())
                .await?;
        }
        self.start_routing().await?;
        self.joined.store(true, Ordering::Release);
        self.abort_if_stopping()?;
        if let Some(controller) = &self.controller
            && !self.controller_standing.swap(true, Ordering::AcqRel)
        {
            controller.start().await?;
        }
        Ok(())
    }

    pub(super) async fn leave(&self) {
        self.joined.store(false, Ordering::Release);
        if let Some(router) = lock(&self.router).take() {
            router.stop();
        }
        if let Some(controller) = &self.controller {
            controller.stop().await;
        }
        self.controller_standing.store(false, Ordering::Release);
        self.stop_heartbeat().await;
        self.stop_memory_reporting().await;
        if self.registered.swap(false, Ordering::AcqRel)
            && let Err(error) = self.coordinator.deregister_node(self.node_id()).await
        {
            self.report(&error);
        }
        if let Some(listening) = lock(&self.listening).take() {
            listening.stop();
        }
        if let Some(data) = &self.data {
            data.close().await;
        }
    }
}
