use std::sync::Arc;

use narsil::Value;

use crate::constants::{
    DEFAULT_CONTROLLER_LEASE_TTL_MS, DEFAULT_NODE_HEARTBEAT_INTERVAL_MS,
    DEFAULT_NODE_LEFT_DELAY_MS, DEFAULT_STANDBY_RETRY_MS,
};
use crate::coordinator::etcd::EtcdCoordinator;
use crate::coordinator::{NodeRegistration, validate_node_id};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::transport::NodeTransport;

const DATA_ROLE: &str = "data";
const KNOWN_ROLES: [&str; 3] = [DATA_ROLE, "coordinator", "controller"];

/// Receives every failure that a running node meets outside a call that its caller awaits, such as a heartbeat
/// that etcd refused or an allocation run that lost its compare-and-set attempts.
pub type NodeErrorHandler = Arc<dyn Fn(&ClusterError) + Send + Sync>;

/// How the controller of a node with the `controller` role holds its lease and how long it keeps a departed node's
/// copies in place, with the TypeScript defaults.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ControllerTiming {
    /// How long the controller lease lasts without a renewal. The controller renews it three times in that span.
    pub lease_ttl_ms: u64,
    /// How long a node that holds no lease waits before it stands for the lease again.
    pub standby_retry_ms: u64,
    /// How long the controller leaves a departed node's copies in the allocation table before it moves them.
    pub node_left_delay_ms: u64,
}

impl Default for ControllerTiming {
    fn default() -> ControllerTiming {
        ControllerTiming {
            lease_ttl_ms: DEFAULT_CONTROLLER_LEASE_TTL_MS,
            standby_retry_ms: DEFAULT_STANDBY_RETRY_MS,
            node_left_delay_ms: DEFAULT_NODE_LEFT_DELAY_MS,
        }
    }
}

/// The settings of a [`ClusterNode`](super::ClusterNode).
pub struct ClusterNodeConfig {
    /// The etcd coordinator that the node registers with and that its controller writes allocation tables through.
    pub coordinator: Arc<EtcdCoordinator>,
    /// The transport that the node listens on and that its controller sends through.
    pub transport: Arc<dyn NodeTransport>,
    /// The registration that the node writes, whose roles may hold `coordinator` and `controller`.
    pub registration: NodeRegistration,
    /// The controller's lease and departure timing.
    pub controller: ControllerTiming,
    /// How often the node writes its registration again.
    pub heartbeat_interval_ms: u64,
    /// Receives the failures that no awaited call returns.
    pub on_error: Option<NodeErrorHandler>,
}

impl ClusterNodeConfig {
    /// Returns the settings of a node that writes `registration`, with the default controller timing, the default
    /// heartbeat interval of 10 seconds, and no error handler.
    pub fn new(
        coordinator: Arc<EtcdCoordinator>,
        transport: Arc<dyn NodeTransport>,
        registration: NodeRegistration,
    ) -> ClusterNodeConfig {
        ClusterNodeConfig {
            coordinator,
            transport,
            registration,
            controller: ControllerTiming::default(),
            heartbeat_interval_ms: DEFAULT_NODE_HEARTBEAT_INTERVAL_MS,
            on_error: None,
        }
    }
}

fn invalid(message: impl Into<String>) -> ClusterError {
    ClusterError::new(codes::CONFIG_INVALID, message)
}

fn require_positive(value: u64, name: &str) -> ClusterResult<()> {
    if value == 0 {
        return Err(invalid(format!(
            "ClusterNodeConfig.{name} must be a positive number of milliseconds"
        ))
        .with_detail(name, Value::Number(0.0)));
    }
    Ok(())
}

pub(crate) fn validate_config(config: &ClusterNodeConfig) -> ClusterResult<()> {
    let registration = &config.registration;
    validate_node_id(&registration.node_id)?;
    if registration.address.is_empty() {
        return Err(invalid(
            "ClusterNodeConfig.registration.address must not be empty",
        ));
    }
    if registration.roles.is_empty() {
        return Err(invalid(
            "ClusterNodeConfig.registration.roles must contain at least one role",
        ));
    }
    for role in &registration.roles {
        if !KNOWN_ROLES.contains(&role.as_str()) {
            return Err(invalid(format!("Invalid role: '{role}'"))
                .with_detail("role", Value::String(role.clone())));
        }
        if role == DATA_ROLE {
            return Err(invalid(
                "A Rust node cannot take the data role, because it does not replicate writes yet; register it with \
                 the coordinator role, the controller role, or both",
            )
            .with_detail("role", Value::String(role.clone())));
        }
    }
    require_positive(config.controller.lease_ttl_ms, "controller.lease_ttl_ms")?;
    require_positive(
        config.controller.standby_retry_ms,
        "controller.standby_retry_ms",
    )?;
    require_positive(config.heartbeat_interval_ms, "heartbeat_interval_ms")
}
