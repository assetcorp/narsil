#![allow(dead_code)]

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use narsil::{DurabilityConfig, DurabilityMode, Map, NarsilConfig, Value};
use narsil_cluster::SPEC_VERSION;
use narsil_cluster::coordinator::etcd::{EtcdCoordinator, EtcdCoordinatorConfig};
use narsil_cluster::coordinator::{NodeCapacity, NodeRegistration};
use narsil_cluster::error::ClusterError;
use narsil_cluster::node::{ClusterNode, ClusterNodeConfig, DataNodeConfig, next_started_at};
use narsil_cluster::transport::NodeTransport;
use narsil_cluster::transport::tcp::{TcpTransport, TcpTransportConfig};

use crate::support::{write_map_header, write_text, write_unsigned};

const SETTLE_WAIT: Duration = Duration::from_secs(30);
const SETTLE_POLL: Duration = Duration::from_millis(50);

const LISTEN_PORT_FLOOR: u32 = 20_000;
const LISTEN_PORT_SPAN: u32 = 12_000;
const LISTEN_ATTEMPTS: usize = 5;
const LISTEN_FAILURE: &str = "The transport failed to listen";

static NEXT_SERIAL: AtomicU64 = AtomicU64::new(0);
static NEXT_LISTEN_PORT: AtomicU32 = AtomicU32::new(0);

fn unique() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("the clock is set")
        .as_nanos();
    let serial = NEXT_SERIAL.fetch_add(1, Ordering::Relaxed);
    format!("{}_{nanos}_{serial}", std::process::id())
}

pub struct Scratch {
    path: PathBuf,
}

impl Scratch {
    pub fn new() -> Scratch {
        let path = std::env::temp_dir().join(format!("narsil-cluster-{}", unique()));
        std::fs::create_dir_all(&path).expect("the scratch directory is made");
        Scratch { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

pub fn engine_config(directory: &Path) -> NarsilConfig {
    NarsilConfig {
        durability: Some(DurabilityConfig {
            directory: Some(directory.to_path_buf()),
            mode: Some(DurabilityMode::Sync),
            ..DurabilityConfig::default()
        }),
        ..NarsilConfig::default()
    }
}

pub fn etcd_endpoint() -> Option<String> {
    std::env::var("NARSIL_ETCD_ENDPOINT")
        .ok()
        .filter(|endpoint| !endpoint.is_empty())
}

pub fn unique_key_prefix() -> String {
    format!("_narsil_data_node_{}", unique())
}

pub async fn coordinator_at(
    endpoint: String,
    key_prefix: String,
    node_heartbeat_ttl_seconds: u64,
) -> Arc<EtcdCoordinator> {
    let coordinator = EtcdCoordinator::connect(EtcdCoordinatorConfig {
        endpoints: vec![endpoint],
        key_prefix,
        node_heartbeat_ttl_seconds,
        ..EtcdCoordinatorConfig::default()
    })
    .await
    .expect("the coordinator connects");
    Arc::new(coordinator)
}

pub async fn cluster_coordinator() -> Option<Arc<EtcdCoordinator>> {
    let endpoint = etcd_endpoint()?;
    let default_ttl = EtcdCoordinatorConfig::default().node_heartbeat_ttl_seconds;
    Some(coordinator_at(endpoint, unique_key_prefix(), default_ttl).await)
}

pub fn metadata_key(index: &str) -> String {
    format!("_narsil/index/{index}/config")
}

pub fn metadata_record(
    index: &str,
    uuid: &str,
    partitions: u64,
    replication_factor: u64,
) -> Vec<u8> {
    let mut out = Vec::new();
    write_map_header(&mut out, 5);
    write_text(&mut out, "indexName");
    write_text(&mut out, index);
    write_text(&mut out, "indexUuid");
    write_text(&mut out, uuid);
    write_text(&mut out, "partitionCount");
    write_unsigned(&mut out, partitions);
    write_text(&mut out, "replicationFactor");
    write_unsigned(&mut out, replication_factor);
    write_text(&mut out, "constraints");
    write_map_header(&mut out, 0);
    out
}

pub fn title_schema() -> Value {
    let mut fields = Map::new();
    fields.insert("title", Value::from("string"));
    Value::Object(fields)
}

pub async fn create_cluster_index(
    coordinator: &EtcdCoordinator,
    index: &str,
    uuid: &str,
    partitions: u64,
    replication_factor: u64,
) {
    let record = metadata_record(index, uuid, partitions, replication_factor);
    assert!(
        coordinator
            .compare_and_set(&metadata_key(index), None, &record)
            .await
            .expect("etcd takes the metadata")
    );
    coordinator
        .put_schema(index, &title_schema())
        .await
        .expect("etcd takes the schema");
}

pub async fn eventually<F, Fut>(what: &str, mut check: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    let deadline = Instant::now() + SETTLE_WAIT;
    while !check().await {
        assert!(Instant::now() < deadline, "timed out waiting until {what}");
        tokio::time::sleep(SETTLE_POLL).await;
    }
}

pub async fn is_served_by(
    coordinator: &EtcdCoordinator,
    index: &str,
    uuid: &str,
    partitions: usize,
    primary: &str,
) -> bool {
    let Some(table) = coordinator
        .allocation(index)
        .await
        .expect("etcd answers for the table")
    else {
        return false;
    };
    table.index_uuid.as_deref() == Some(uuid)
        && table.assignments.len() == partitions
        && table.assignments.iter().all(|(_, assignment)| {
            assignment.get("state").and_then(Value::as_str) == Some("ACTIVE")
                && assignment.get("primary").and_then(Value::as_str) == Some(primary)
        })
}

pub fn free_port() -> u16 {
    let start = std::process::id() % LISTEN_PORT_SPAN;
    for _ in 0..LISTEN_PORT_SPAN {
        let step = NEXT_LISTEN_PORT.fetch_add(1, Ordering::Relaxed);
        let port = LISTEN_PORT_FLOOR + (start + step) % LISTEN_PORT_SPAN;
        let port = u16::try_from(port).expect("every listen port fits in 16 bits");
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return port;
        }
    }
    panic!("every port from {LISTEN_PORT_FLOOR} on is taken");
}

pub struct DataNode {
    pub node: ClusterNode,
    pub transport: Arc<TcpTransport>,
    pub address: String,
    pub reported: Arc<Mutex<Vec<ClusterError>>>,
}

impl DataNode {
    pub async fn start(
        coordinator: &Arc<EtcdCoordinator>,
        node_id: &str,
        directory: &Path,
    ) -> DataNode {
        DataNode::start_with_roles(coordinator, node_id, directory, &["data"]).await
    }

    pub async fn start_with_roles(
        coordinator: &Arc<EtcdCoordinator>,
        node_id: &str,
        directory: &Path,
        roles: &[&str],
    ) -> DataNode {
        DataNode::start_configured(coordinator, node_id, directory, roles, |_| {}).await
    }

    pub async fn start_configured(
        coordinator: &Arc<EtcdCoordinator>,
        node_id: &str,
        directory: &Path,
        roles: &[&str],
        configure: fn(&mut ClusterNodeConfig),
    ) -> DataNode {
        let mut attempts = 0;
        loop {
            attempts += 1;
            match DataNode::try_start(coordinator, node_id, directory, roles, configure).await {
                Ok(started) => return started,
                Err(error)
                    if attempts < LISTEN_ATTEMPTS
                        && error.code() == "TRANSPORT_CONNECT_FAILED"
                        && error.message().starts_with(LISTEN_FAILURE) => {}
                Err(error) => panic!("the data node joins: {error:?}"),
            }
        }
    }

    async fn try_start(
        coordinator: &Arc<EtcdCoordinator>,
        node_id: &str,
        directory: &Path,
        roles: &[&str],
        configure: fn(&mut ClusterNodeConfig),
    ) -> Result<DataNode, ClusterError> {
        let port = free_port();
        let address = format!("127.0.0.1:{port}");
        let transport = Arc::new(
            TcpTransport::new(
                node_id,
                TcpTransportConfig {
                    host: "127.0.0.1".to_string(),
                    port,
                    ..TcpTransportConfig::default()
                },
            )
            .expect("the transport settings are valid"),
        );
        let mut settings = ClusterNodeConfig::new(
            Arc::clone(coordinator),
            transport.clone(),
            NodeRegistration {
                node_id: node_id.to_string(),
                address: address.clone(),
                roles: roles.iter().map(|role| role.to_string()).collect(),
                capacity: NodeCapacity::default(),
                started_at: next_started_at(),
                version: SPEC_VERSION.to_string(),
                extra: Map::new(),
            },
        );
        if roles.contains(&"data") {
            settings.data = Some(DataNodeConfig::new(engine_config(directory)));
        }
        let reported = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&reported);
        settings.on_error = Some(Arc::new(move |error| {
            sink.lock()
                .expect("no reporter panicked")
                .push(error.clone());
        }));
        configure(&mut settings);
        let node = ClusterNode::new(settings).expect("the data node's settings are valid");
        if let Err(error) = node.start().await {
            node.shutdown().await;
            transport.shutdown().await;
            return Err(error);
        }
        Ok(DataNode {
            node,
            transport,
            address,
            reported,
        })
    }

    pub async fn stop(self) {
        self.node.shutdown().await;
        self.transport.shutdown().await;
    }
}
