#![allow(dead_code)]

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use narsil::{DurabilityConfig, DurabilityMode, Map, NarsilConfig};
use narsil_cluster::SPEC_VERSION;
use narsil_cluster::coordinator::etcd::{EtcdCoordinator, EtcdCoordinatorConfig};
use narsil_cluster::coordinator::{NodeCapacity, NodeRegistration};
use narsil_cluster::error::ClusterError;
use narsil_cluster::node::{ClusterNode, ClusterNodeConfig, DataNodeConfig, next_started_at};
use narsil_cluster::transport::NodeTransport;
use narsil_cluster::transport::tcp::{TcpTransport, TcpTransportConfig};

use crate::support::{write_map_header, write_text, write_unsigned};

static NEXT_SERIAL: AtomicU64 = AtomicU64::new(0);

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

pub async fn cluster_coordinator() -> Option<Arc<EtcdCoordinator>> {
    let endpoint = std::env::var("NARSIL_ETCD_ENDPOINT")
        .ok()
        .filter(|endpoint| !endpoint.is_empty())?;
    let coordinator = EtcdCoordinator::connect(EtcdCoordinatorConfig {
        endpoints: vec![endpoint],
        key_prefix: format!("_narsil_data_node_{}", unique()),
        ..EtcdCoordinatorConfig::default()
    })
    .await
    .expect("the coordinator connects");
    Some(Arc::new(coordinator))
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

fn free_port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .expect("the host gives a free port")
        .port()
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
                roles: vec!["data".to_string()],
                capacity: NodeCapacity::default(),
                started_at: next_started_at(),
                version: SPEC_VERSION.to_string(),
                extra: Map::new(),
            },
        );
        settings.data = Some(DataNodeConfig::new(engine_config(directory)));
        let reported = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&reported);
        settings.on_error = Some(Arc::new(move |error| {
            sink.lock()
                .expect("no reporter panicked")
                .push(error.clone());
        }));
        let node = ClusterNode::new(settings).expect("the data node's settings are valid");
        node.start().await.expect("the data node joins");
        DataNode {
            node,
            transport,
            address,
            reported,
        }
    }

    pub async fn stop(self) {
        self.node.shutdown().await;
        self.transport.shutdown().await;
    }
}
