use std::collections::BTreeMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;

use narsil::coordination::RerankHost;
use narsil::{QuerySuggestionsConfig, RerankAdapter, Value};

use crate::backups::{ClusterBackupConfig, validate_backup_config};
use crate::constants::{
    DEFAULT_CONTROLLER_LEASE_TTL_MS, DEFAULT_IN_FLIGHT_WRITE_FRACTION,
    DEFAULT_NODE_HEARTBEAT_INTERVAL_MS, DEFAULT_NODE_LEFT_DELAY_MS,
    DEFAULT_QUERY_PARTITION_TIMEOUT_MS, DEFAULT_STANDBY_RETRY_MS,
};
use crate::coordinator::etcd::EtcdCoordinator;
use crate::coordinator::{NodeRegistration, validate_node_id};
use crate::data::DataNodeConfig;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::transport::NodeTransport;

const DATA_ROLE: &str = "data";
const KNOWN_ROLES: [&str; 3] = [DATA_ROLE, "coordinator", "controller"];

/// Receives every failure that a running node meets outside a call that its caller awaits, such as a heartbeat
/// that etcd refused or an allocation run that lost its compare-and-set attempts.
pub type NodeErrorHandler = Arc<dyn Fn(&ClusterError) + Send + Sync>;

pub(crate) fn report_failure(on_error: Option<&NodeErrorHandler>, error: &ClusterError) {
    if let Some(on_error) = on_error {
        let _ = catch_unwind(AssertUnwindSafe(|| on_error(error)));
    }
}

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

/// How a node answers a search that some partitions failed to answer, with the TypeScript defaults.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClusterQueryConfig {
    /// Whether a search answers from the partitions that did answer, reporting the rest in its coverage, or
    /// refuses with `QUERY_PARTIAL_FAILURE`.
    pub allow_partial_results: bool,
    /// How long a search waits for each node's answer before it counts that node's partitions as timed out.
    pub partition_timeout_ms: u64,
}

impl Default for ClusterQueryConfig {
    fn default() -> ClusterQueryConfig {
        ClusterQueryConfig {
            allow_partial_results: true,
            partition_timeout_ms: DEFAULT_QUERY_PARTITION_TIMEOUT_MS,
        }
    }
}

/// The rerank adapters that a node scores the best hits of a cluster search with, and the timeout and window that
/// its calls follow.
#[derive(Clone, Default)]
pub struct ClusterRerankConfig {
    /// The adapters that a query gives by name in `rerank.adapter`. A node with the `data` role also scores with the
    /// adapters in `data.rerank_adapters`, and an adapter here replaces one there under the same name.
    pub adapters: BTreeMap<String, Arc<dyn RerankAdapter>>,
    /// How many milliseconds an adapter may take before the search fails with `RERANK_FAILED`, from 1 to
    /// 2,147,483,647. `None` takes `data.engine.rerank_timeout_ms` on a node with the `data` role, and 30,000 otherwise.
    pub timeout_ms: Option<u64>,
    /// The most hits that one search may rerank, from 1 to 1,000. `None` takes `data.engine.max_rerank_window` on a
    /// node with the `data` role, and 100 otherwise.
    pub max_window: Option<usize>,
}

/// The settings of a [`ClusterNode`](super::ClusterNode).
pub struct ClusterNodeConfig {
    /// The etcd coordinator that the node registers with and that its controller writes allocation tables through.
    pub coordinator: Arc<EtcdCoordinator>,
    /// The transport that the node listens on and that its controller sends through.
    pub transport: Arc<dyn NodeTransport>,
    /// The registration that the node writes, whose roles may hold `data`, `coordinator`, and `controller`.
    pub registration: NodeRegistration,
    /// The controller's lease and departure timing.
    pub controller: ControllerTiming,
    /// The settings of the `data` role, which a node with that role needs and any other node leaves out.
    pub data: Option<DataNodeConfig>,
    /// How often the node writes its registration again.
    pub heartbeat_interval_ms: u64,
    /// The share of the node's memory limit that the inserts and updates in progress on the node may hold, above 0
    /// and at most 1, and 0.02 by default. The node refuses a write with `CLUSTER_WRITE_BLOCKED` when its bytes
    /// would take the writes in progress past that share, and it accepts any write that arrives while no other is in
    /// progress.
    pub in_flight_write_fraction: f64,
    /// How the node answers a search that some partitions failed to answer.
    pub query: ClusterQueryConfig,
    /// Where the cluster keeps its backups, which every node of the cluster sets alike, or `None` for a node that
    /// takes no part in a backup.
    pub backups: Option<ClusterBackupConfig>,
    /// The rerank adapters that the node scores a reranked search with, which every node that takes searches from
    /// clients needs, whatever its roles.
    pub rerank: ClusterRerankConfig,
    /// The key that scrambles each person whose searches the node counts for popular query suggestions, which
    /// every node of the cluster sets alike, or `None` for a node that counts nothing and builds nothing. A node with
    /// the `data` role keeps its counts beside its copies; any other node keeps them in memory.
    pub query_suggestions: Option<QuerySuggestionsConfig>,
    /// Receives the failures that no awaited call returns.
    pub on_error: Option<NodeErrorHandler>,
}

impl ClusterNodeConfig {
    /// Returns the settings of a node that writes `registration`, with the default controller timing, the default
    /// heartbeat interval of 10 seconds, searches that answer from the partitions that answer within 5 seconds, no
    /// rerank adapter, no error handler, no data settings, no backup store, and no query suggestions key.
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
            data: None,
            heartbeat_interval_ms: DEFAULT_NODE_HEARTBEAT_INTERVAL_MS,
            in_flight_write_fraction: DEFAULT_IN_FLIGHT_WRITE_FRACTION,
            query: ClusterQueryConfig::default(),
            backups: None,
            rerank: ClusterRerankConfig::default(),
            query_suggestions: None,
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

pub(crate) fn rerank_host_of(config: &ClusterNodeConfig) -> ClusterResult<Arc<RerankHost>> {
    let data = config.data.as_ref();
    let timeout_ms = config
        .rerank
        .timeout_ms
        .or_else(|| data.and_then(|data| data.engine.rerank_timeout_ms));
    let max_window = config
        .rerank
        .max_window
        .or_else(|| data.and_then(|data| data.engine.max_rerank_window));
    let host = RerankHost::new(timeout_ms, max_window)?;
    let data_adapters = data.into_iter().flat_map(|data| &data.rerank_adapters);
    for (name, adapter) in data_adapters.chain(&config.rerank.adapters) {
        host.register(name, Arc::clone(adapter))?;
    }
    Ok(Arc::new(host))
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
    }
    let holds_data_role = registration.roles.iter().any(|role| role == DATA_ROLE);
    if holds_data_role != config.data.is_some() {
        let message = if holds_data_role {
            "ClusterNodeConfig.data must hold the local engine's settings for a node with the data role"
        } else {
            "ClusterNodeConfig.data must be absent for a node without the data role"
        };
        return Err(invalid(message).with_detail("role", Value::String(DATA_ROLE.to_string())));
    }
    if config
        .data
        .as_ref()
        .is_some_and(|data| data.log_retention_bytes == 0)
    {
        return Err(invalid(
            "ClusterNodeConfig.data.log_retention_bytes must be a positive number of bytes",
        )
        .with_detail("data.log_retention_bytes", Value::Number(0.0)));
    }
    require_positive(config.controller.lease_ttl_ms, "controller.lease_ttl_ms")?;
    require_positive(
        config.controller.standby_retry_ms,
        "controller.standby_retry_ms",
    )?;
    let fraction = config.in_flight_write_fraction;
    if !(fraction > 0.0 && fraction <= 1.0) {
        return Err(invalid(
            "ClusterNodeConfig.in_flight_write_fraction must be above 0 and at most 1",
        )
        .with_detail("in_flight_write_fraction", Value::Number(fraction)));
    }
    if let Some(backups) = &config.backups {
        validate_backup_config(backups)?;
    }
    if config
        .data
        .as_ref()
        .is_some_and(|data| data.engine.query_suggestions.is_some())
    {
        return Err(invalid(
            "ClusterNodeConfig.data.engine.query_suggestions must be None, because a cluster node counts searches with ClusterNodeConfig.query_suggestions",
        ));
    }
    require_positive(config.heartbeat_interval_ms, "heartbeat_interval_ms")?;
    require_positive(
        config.query.partition_timeout_ms,
        "query.partition_timeout_ms",
    )
}
