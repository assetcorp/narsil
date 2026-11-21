use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use narsil::Value;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use super::config::{ClusterNodeConfig, NodeErrorHandler, validate_config};
use super::join::{
    refuse_controller_on_another_major_version, wait_for_earlier_registration_to_lapse,
};
use super::not_ready::{answer_ping, not_ready};
use crate::controller::{
    Controller, ControllerConfig, ControllerErrorHandler, is_controller_message, lock,
};
use crate::coordinator::NodeRegistration;
use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{TransportMessage, message_types, refusal};
use crate::transport::{Listening, NodeTransport, Respond, listen_handler};

const CONTROLLER_ROLE: &str = "controller";
const PARTITION_BYTES_FIELD: &str = "partitionBytes";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Idle,
    Joining,
    Active,
    Shutdown,
}

struct Heartbeat {
    stop: watch::Sender<bool>,
    task: JoinHandle<()>,
}

struct NodeInner {
    coordinator: Arc<EtcdCoordinator>,
    transport: Arc<dyn NodeTransport>,
    registration: NodeRegistration,
    heartbeat_interval_ms: u64,
    on_error: Option<NodeErrorHandler>,
    controller: Option<Controller>,
    phase: Mutex<Phase>,
    lifecycle: tokio::sync::Mutex<()>,
    stopping: watch::Sender<bool>,
    joined: AtomicBool,
    registered: AtomicBool,
    heartbeat: Mutex<Option<Heartbeat>>,
    listening: Mutex<Option<Listening>>,
}

fn not_controller(node_id: &str) -> ClusterError {
    ClusterError::new(
        codes::NODE_NOT_CONTROLLER,
        format!("Node '{node_id}' holds no controller lease, so it answers no controller message"),
    )
    .with_detail("nodeId", Value::String(node_id.to_string()))
}

fn node_error(code: &str, message: String, node_id: &str) -> ClusterError {
    ClusterError::new(code, message).with_detail("nodeId", Value::String(node_id.to_string()))
}

impl NodeInner {
    fn node_id(&self) -> &str {
        &self.registration.node_id
    }

    fn report(&self, error: &ClusterError) {
        if let Some(on_error) = &self.on_error {
            on_error(error);
        }
    }

    fn is_stopping(&self) -> bool {
        *self.stopping.borrow()
    }

    async fn answer(&self, message: TransportMessage, respond: Respond) {
        let node_id = self.node_id();
        if message.message_type == message_types::CLUSTER_PING {
            return respond.send(answer_ping(&message, node_id)).await;
        }
        if !self.joined.load(Ordering::Acquire) || !is_controller_message(&message.message_type) {
            return respond
                .send(refusal(&message, node_id, &not_ready(node_id)))
                .await;
        }
        match &self.controller {
            Some(controller) if controller.is_listening() => {
                controller.handle(message, respond).await
            }
            _ => {
                respond
                    .send(refusal(&message, node_id, &not_controller(node_id)))
                    .await
            }
        }
    }

    async fn write_registration(&self) -> ClusterResult<()> {
        let Err(error) = self.coordinator.register_node(&self.registration).await else {
            return Ok(());
        };
        if error.code() != codes::CONFIG_INVALID
            || self.registration.extra.get(PARTITION_BYTES_FIELD).is_none()
        {
            return Err(error);
        }
        let mut smaller = self.registration.clone();
        smaller.extra.remove(PARTITION_BYTES_FIELD);
        self.coordinator.register_node(&smaller).await?;
        Err(error)
    }

    fn start_heartbeat(self: &Arc<Self>) {
        let (stop, mut stopped) = watch::channel(false);
        let inner = Arc::downgrade(self);
        let every = Duration::from_millis(self.heartbeat_interval_ms);
        let task = tokio::spawn(async move {
            let mut ticks = tokio::time::interval(every);
            ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            ticks.tick().await;
            loop {
                tokio::select! {
                    _ = ticks.tick() => {}
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

    async fn stop_heartbeat(&self) {
        let Some(heartbeat) = lock(&self.heartbeat).take() else {
            return;
        };
        let _ = heartbeat.stop.send(true);
        let _ = heartbeat.task.await;
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

    async fn join(self: &Arc<Self>) -> ClusterResult<()> {
        self.listen().await?;
        refuse_controller_on_another_major_version(&self.coordinator, &self.registration).await?;
        let mut stopping = self.stopping.subscribe();
        wait_for_earlier_registration_to_lapse(&self.coordinator, self.node_id(), &mut stopping)
            .await?;
        self.abort_if_stopping()?;
        self.coordinator.register_node(&self.registration).await?;
        self.registered.store(true, Ordering::Release);
        self.start_heartbeat();
        self.joined.store(true, Ordering::Release);
        self.abort_if_stopping()?;
        if let Some(controller) = &self.controller {
            controller.start().await?;
        }
        Ok(())
    }

    async fn leave(&self) {
        self.joined.store(false, Ordering::Release);
        if let Some(controller) = &self.controller {
            controller.stop().await;
        }
        self.stop_heartbeat().await;
        if self.registered.swap(false, Ordering::AcqRel)
            && let Err(error) = self.coordinator.deregister_node(self.node_id()).await
        {
            self.report(&error);
        }
        if let Some(listening) = lock(&self.listening).take() {
            listening.stop();
        }
    }
}

/// A Rust node that joins a Narsil cluster with the `coordinator` role, the `controller` role, or both, and takes
/// the steps that a TypeScript node of those roles takes.
///
/// A node with the `controller` role stands for the controller lease once it joins. While it holds the lease, it
/// places every index's partitions on the data nodes, answers the in-sync, bootstrap, and resignation messages that
/// a primary sends, and refuses the replication factor, rebalance, backup, and query suggestion requests with
/// `CLUSTER_OPERATION_UNSUPPORTED`. A node on another major specification version than the active controller
/// cannot join.
pub struct ClusterNode {
    inner: Arc<NodeInner>,
}

impl ClusterNode {
    /// Returns a node that has yet to join, from `config`.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` where the registration holds no role, an unknown role, or the `data` role, an
    /// empty address, or an invalid node id, or where a timing value is zero.
    pub fn new(config: ClusterNodeConfig) -> ClusterResult<ClusterNode> {
        validate_config(&config)?;
        let ClusterNodeConfig {
            coordinator,
            transport,
            registration,
            controller: timing,
            heartbeat_interval_ms,
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
        Ok(ClusterNode {
            inner: Arc::new(NodeInner {
                coordinator,
                transport,
                registration,
                heartbeat_interval_ms,
                on_error,
                controller,
                phase: Mutex::new(Phase::Idle),
                lifecycle: tokio::sync::Mutex::new(()),
                stopping: watch::Sender::new(false),
                joined: AtomicBool::new(false),
                registered: AtomicBool::new(false),
                heartbeat: Mutex::new(None),
                listening: Mutex::new(None),
            }),
        })
    }

    /// Returns the node's id.
    pub fn node_id(&self) -> &str {
        self.inner.node_id()
    }

    /// Reports whether the node holds the controller lease.
    pub fn is_controller(&self) -> bool {
        self.inner
            .controller
            .as_ref()
            .is_some_and(Controller::is_active)
    }

    /// Joins the cluster, and returns once the node is registered and, for a node with the `controller` role, has
    /// stood for the controller lease once.
    ///
    /// The node opens its listener first, and answers `cluster.ping` from then on. Where etcd holds a live
    /// registration under the node's id, the node waits for that registration's lease to lapse before it writes its
    /// own. It renews its registration on every heartbeat interval until it shuts down. A failed join removes what
    /// the join wrote and leaves the node free to start again.
    ///
    /// # Errors
    ///
    /// Fails with `NODE_VERSION_INCOMPATIBLE` before it writes anything where the active controller follows a
    /// specification version with another major version, with `NODE_ALREADY_JOINED` where the node is joining or
    /// has joined, with `NODE_NOT_JOINED` where the node shut down, and with the coordinator's or the transport's
    /// error where either fails.
    pub async fn start(&self) -> ClusterResult<()> {
        let _turn = self.inner.lifecycle.lock().await;
        let node_id = self.node_id();
        {
            let mut phase = lock(&self.inner.phase);
            match *phase {
                Phase::Idle => *phase = Phase::Joining,
                Phase::Shutdown => {
                    return Err(node_error(
                        codes::NODE_NOT_JOINED,
                        format!("Node '{node_id}' has been shut down and cannot rejoin"),
                        node_id,
                    ));
                }
                Phase::Joining | Phase::Active => {
                    return Err(node_error(
                        codes::NODE_ALREADY_JOINED,
                        format!("Node '{node_id}' has already joined the cluster"),
                        node_id,
                    ));
                }
            }
        }
        match self.inner.join().await {
            Ok(()) => {
                *lock(&self.inner.phase) = Phase::Active;
                Ok(())
            }
            Err(error) => {
                self.inner.leave().await;
                let mut phase = lock(&self.inner.phase);
                if *phase == Phase::Joining {
                    *phase = Phase::Idle;
                }
                Err(error)
            }
        }
    }

    /// Leaves the cluster for good: the node gives up the controller lease where it holds it, stops renewing its
    /// registration, deregisters, and stops listening.
    ///
    /// A shutdown during a start ends the wait for an earlier registration, and the start then fails with
    /// `NODE_NOT_JOINED`. The coordinator and the transport stay open, because the caller owns them. A second
    /// call does nothing.
    pub async fn shutdown(&self) {
        self.inner.stopping.send_replace(true);
        let _turn = self.inner.lifecycle.lock().await;
        let earlier = std::mem::replace(&mut *lock(&self.inner.phase), Phase::Shutdown);
        if earlier != Phase::Shutdown {
            self.inner.leave().await;
        }
    }
}
