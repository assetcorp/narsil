use std::path::{Path, PathBuf};
use std::sync::Arc;

use narsil::{DurabilityConfig, Map, NarsilConfig};
use narsil_cluster::SPEC_VERSION;
use narsil_cluster::coordinator::etcd::{
    EtcdAuthConfig, EtcdCoordinator, EtcdCoordinatorConfig, EtcdTlsConfig,
};
use narsil_cluster::coordinator::{NodeCapacity, NodeRegistration};
use narsil_cluster::error::ClusterError;
use narsil_cluster::node::{
    ClusterNode, ClusterNodeConfig, ControllerTiming, CreateIndexOptions, DataNodeConfig,
    next_started_at, resolve_node_id,
};
use narsil_cluster::transport::grpc::{GrpcTransport, GrpcTransportConfig};
use narsil_cluster::transport::tcp::{TcpTransport, TcpTransportConfig};
use narsil_cluster::transport::{NodeTransport, TlsConfig};
use narsil_server::ClusterOptions;

use super::{number_from_env, text_from_env};

pub(crate) const ETCD_ENDPOINTS_VARIABLE: &str = "NARSIL_CLUSTER_ETCD_ENDPOINTS";
const DEFAULT_ROLES: &str = "data,coordinator,controller";
const DEFAULT_TRANSPORT_HOST: &str = "127.0.0.1";
const DATA_ROLE: &str = "data";
const TCP_TRANSPORT: &str = "tcp";
const GRPC_TRANSPORT: &str = "grpc";

pub(crate) struct ClusterLaunch {
    etcd: EtcdCoordinatorConfig,
    roles: Vec<String>,
    node_id: Option<String>,
    grpc: bool,
    transport_host: String,
    transport_port: Option<u16>,
    advertised_address: Option<String>,
    transport_tls: Option<TlsConfig>,
    controller: ControllerTiming,
    durability_directory: Option<PathBuf>,
    pub(crate) cluster_options: ClusterOptions,
}

pub(crate) struct StartedNode {
    pub(crate) node: Arc<ClusterNode>,
    transport: Arc<dyn NodeTransport>,
    coordinator: Arc<EtcdCoordinator>,
}

impl StartedNode {
    pub(crate) async fn close(self) {
        self.transport.shutdown().await;
        self.coordinator.shutdown().await;
    }
}

fn listed(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect()
}

fn file_bytes(variable: &str) -> Result<Option<Vec<u8>>, String> {
    let Some(path) = text_from_env(variable) else {
        return Ok(None);
    };
    std::fs::read(&path)
        .map(Some)
        .map_err(|failure| format!("{variable} names \"{path}\", which cannot be read: {failure}"))
}

fn etcd_tls() -> Result<Option<EtcdTlsConfig>, String> {
    let cert = file_bytes("NARSIL_CLUSTER_ETCD_CERT_FILE")?;
    let key = file_bytes("NARSIL_CLUSTER_ETCD_KEY_FILE")?;
    match file_bytes("NARSIL_CLUSTER_ETCD_CA_FILE")? {
        Some(ca) => Ok(Some(EtcdTlsConfig { ca, cert, key })),
        None if cert.is_none() && key.is_none() => Ok(None),
        None => Err(
            "NARSIL_CLUSTER_ETCD_CERT_FILE and NARSIL_CLUSTER_ETCD_KEY_FILE need NARSIL_CLUSTER_ETCD_CA_FILE"
                .to_string(),
        ),
    }
}

fn etcd_auth() -> Result<Option<EtcdAuthConfig>, String> {
    let username = text_from_env("NARSIL_CLUSTER_ETCD_USERNAME");
    let password = text_from_env("NARSIL_CLUSTER_ETCD_PASSWORD");
    match (username, password) {
        (Some(username), Some(password)) => Ok(Some(EtcdAuthConfig { username, password })),
        (None, None) => Ok(None),
        _ => Err(
            "NARSIL_CLUSTER_ETCD_USERNAME and NARSIL_CLUSTER_ETCD_PASSWORD must be set together"
                .to_string(),
        ),
    }
}

fn transport_tls() -> Result<Option<TlsConfig>, String> {
    let cert = file_bytes("NARSIL_CLUSTER_TLS_CERT_FILE")?;
    let key = file_bytes("NARSIL_CLUSTER_TLS_KEY_FILE")?;
    let ca = file_bytes("NARSIL_CLUSTER_TLS_CA_FILE")?;
    match (cert, key, ca) {
        (Some(cert), Some(key), Some(ca)) => Ok(Some(TlsConfig { cert, key, ca })),
        (None, None, None) => Ok(None),
        _ => Err(
            "NARSIL_CLUSTER_TLS_CERT_FILE, NARSIL_CLUSTER_TLS_KEY_FILE, and NARSIL_CLUSTER_TLS_CA_FILE must be set together"
                .to_string(),
        ),
    }
}

fn controller_timing() -> Result<ControllerTiming, String> {
    let defaults = ControllerTiming::default();
    Ok(ControllerTiming {
        lease_ttl_ms: number_from_env("NARSIL_CLUSTER_CONTROLLER_LEASE_TTL_MS")?
            .unwrap_or(defaults.lease_ttl_ms),
        standby_retry_ms: number_from_env("NARSIL_CLUSTER_STANDBY_RETRY_MS")?
            .unwrap_or(defaults.standby_retry_ms),
        node_left_delay_ms: number_from_env("NARSIL_CLUSTER_NODE_LEFT_DELAY_MS")?
            .unwrap_or(defaults.node_left_delay_ms),
    })
}

fn transport_kind() -> Result<bool, String> {
    match text_from_env("NARSIL_CLUSTER_TRANSPORT").as_deref() {
        None | Some(TCP_TRANSPORT) => Ok(false),
        Some(GRPC_TRANSPORT) => Ok(true),
        Some(other) => Err(format!(
            "NARSIL_CLUSTER_TRANSPORT must be \"tcp\" or \"grpc\", got \"{other}\""
        )),
    }
}

fn port_from_env(name: &str) -> Result<Option<u16>, String> {
    number_from_env(name)?
        .map(|port| {
            u16::try_from(port).map_err(|_| format!("{name} must be at most 65535, got {port}"))
        })
        .transpose()
}

fn count_from_env(name: &str) -> Result<Option<u32>, String> {
    number_from_env(name)?
        .map(|count| {
            u32::try_from(count)
                .map_err(|_| format!("{name} must be at most {}, got {count}", u32::MAX))
        })
        .transpose()
}

fn create_index_options() -> Result<CreateIndexOptions, String> {
    Ok(CreateIndexOptions {
        partition_count: count_from_env("NARSIL_CLUSTER_PARTITION_COUNT")?,
        replication_factor: count_from_env("NARSIL_CLUSTER_REPLICATION_FACTOR")?,
        wait_for_serving_ms: number_from_env("NARSIL_CLUSTER_WAIT_FOR_SERVING_MS")?,
    })
}

fn failed(what: &str) -> impl Fn(ClusterError) -> String + '_ {
    move |failure| format!("{what}: {failure}")
}

impl ClusterLaunch {
    pub(crate) fn from_env() -> Result<Option<ClusterLaunch>, String> {
        let Some(endpoints) = text_from_env(ETCD_ENDPOINTS_VARIABLE) else {
            return Ok(None);
        };
        let mut etcd = EtcdCoordinatorConfig {
            endpoints: listed(&endpoints),
            tls: etcd_tls()?,
            auth: etcd_auth()?,
            ..EtcdCoordinatorConfig::default()
        };
        if let Some(key_prefix) = text_from_env("NARSIL_CLUSTER_KEY_PREFIX") {
            etcd.key_prefix = key_prefix;
        }
        if let Some(seconds) = number_from_env("NARSIL_CLUSTER_HEARTBEAT_TTL_SECONDS")? {
            etcd.node_heartbeat_ttl_seconds = seconds;
        }
        let roles = text_from_env("NARSIL_CLUSTER_ROLES").unwrap_or_else(|| DEFAULT_ROLES.into());
        Ok(Some(ClusterLaunch {
            etcd,
            roles: listed(&roles),
            node_id: text_from_env("NARSIL_CLUSTER_NODE_ID"),
            grpc: transport_kind()?,
            transport_host: text_from_env("NARSIL_CLUSTER_TRANSPORT_HOST")
                .unwrap_or_else(|| DEFAULT_TRANSPORT_HOST.to_string()),
            transport_port: port_from_env("NARSIL_CLUSTER_TRANSPORT_PORT")?,
            advertised_address: text_from_env("NARSIL_CLUSTER_ADVERTISED_ADDRESS"),
            transport_tls: transport_tls()?,
            controller: controller_timing()?,
            durability_directory: text_from_env("NARSIL_DURABILITY_DIR").map(PathBuf::from),
            cluster_options: ClusterOptions {
                create_index: create_index_options()?,
            },
        }))
    }

    fn transport(&self, node_id: &str) -> Result<(Arc<dyn NodeTransport>, u16), String> {
        let tls = self.transport_tls.clone();
        let host = self.transport_host.clone();
        if self.grpc {
            let defaults = GrpcTransportConfig::default();
            let port = self.transport_port.unwrap_or(defaults.port);
            let config = GrpcTransportConfig {
                host,
                port,
                tls,
                ..defaults
            };
            let transport = GrpcTransport::new(node_id, config)
                .map_err(failed("The gRPC transport refused its settings"))?;
            return Ok((Arc::new(transport), port));
        }
        let defaults = TcpTransportConfig::default();
        let port = self.transport_port.unwrap_or(defaults.port);
        let config = TcpTransportConfig {
            host,
            port,
            tls,
            ..defaults
        };
        let transport = TcpTransport::new(node_id, config)
            .map_err(failed("The TCP transport refused its settings"))?;
        Ok((Arc::new(transport), port))
    }

    fn data(&self) -> Option<DataNodeConfig> {
        if !self.roles.iter().any(|role| role == DATA_ROLE) {
            return None;
        }
        let durability = self.durability_directory.as_deref().map(durable_at);
        Some(DataNodeConfig::new(NarsilConfig {
            durability,
            ..NarsilConfig::default()
        }))
    }

    pub(crate) async fn start(self) -> Result<StartedNode, String> {
        let node_id = resolve_node_id(
            self.node_id.as_deref(),
            self.durability_directory.as_deref(),
        )
        .map_err(failed("The node id could not be resolved"))?;
        let (transport, port) = self.transport(&node_id)?;
        let coordinator = EtcdCoordinator::connect(self.etcd.clone())
            .await
            .map_err(failed("etcd could not be reached"))?;
        let coordinator = Arc::new(coordinator);
        let registration = NodeRegistration {
            node_id: node_id.clone(),
            address: self
                .advertised_address
                .clone()
                .unwrap_or_else(|| format!("{}:{port}", self.transport_host)),
            roles: self.roles.clone(),
            capacity: NodeCapacity::default(),
            started_at: next_started_at(),
            version: SPEC_VERSION.to_string(),
            extra: Map::new(),
        };
        let reporting_id = node_id.clone();
        let config = ClusterNodeConfig {
            controller: self.controller,
            data: self.data(),
            on_error: Some(Arc::new(move |error: &ClusterError| {
                eprintln!("{reporting_id}: {error}");
            })),
            ..ClusterNodeConfig::new(
                Arc::clone(&coordinator),
                Arc::clone(&transport),
                registration,
            )
        };
        let started = StartedNode {
            node: Arc::new(
                ClusterNode::new(config)
                    .map_err(failed("The cluster node refused its settings"))?,
            ),
            transport,
            coordinator,
        };
        if let Err(failure) = started.node.start().await {
            started.node.shutdown().await;
            started.close().await;
            return Err(format!("The cluster node failed to join: {failure}"));
        }
        Ok(started)
    }
}

fn durable_at(directory: &Path) -> DurabilityConfig {
    DurabilityConfig {
        directory: Some(directory.to_path_buf()),
        ..DurabilityConfig::default()
    }
}
