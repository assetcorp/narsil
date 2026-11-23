mod settings;

use std::process::ExitCode;
use std::sync::Arc;

use narsil::{DurabilityConfig, DurabilityMode, Map, NarsilConfig};
use narsil_cluster::coordinator::etcd::EtcdCoordinator;
use narsil_cluster::coordinator::{NodeCapacity, NodeRegistration};
use narsil_cluster::error::ClusterError;
use narsil_cluster::node::{
    ClusterNode, ClusterNodeConfig, DataNodeConfig, next_started_at, resolve_node_id,
};
use narsil_cluster::transport::NodeTransport;
use narsil_cluster::transport::grpc::{GrpcTransport, GrpcTransportConfig};
use narsil_cluster::transport::tcp::{TcpTransport, TcpTransportConfig};
use narsil_server::{ClusterOptions, NarsilServer, ServerOptions};

use self::settings::{FaultNodeSettings, read_settings};

const LISTEN_HOST: &str = "127.0.0.1";
const DATA_ROLE: &str = "data";

fn create_transport(
    node_id: &str,
    settings: &FaultNodeSettings,
) -> Result<Arc<dyn NodeTransport>, String> {
    let tls = settings.transport_tls.clone();
    if settings.grpc {
        let config = GrpcTransportConfig {
            host: LISTEN_HOST.to_string(),
            port: settings.transport_port,
            tls,
            ..GrpcTransportConfig::default()
        };
        return Ok(Arc::new(
            GrpcTransport::new(node_id, config).map_err(|error| error.to_string())?,
        ));
    }
    let config = TcpTransportConfig {
        host: LISTEN_HOST.to_string(),
        port: settings.transport_port,
        tls,
        ..TcpTransportConfig::default()
    };
    Ok(Arc::new(
        TcpTransport::new(node_id, config).map_err(|error| error.to_string())?,
    ))
}

fn data_config(settings: &FaultNodeSettings) -> Result<Option<DataNodeConfig>, String> {
    if !settings.roles.iter().any(|role| role == DATA_ROLE) {
        return Ok(None);
    }
    let Some(directory) = &settings.directory else {
        return Err("A fault node with the data role needs a directory".to_string());
    };
    let engine = NarsilConfig {
        durability: Some(DurabilityConfig {
            directory: Some(directory.clone()),
            mode: Some(DurabilityMode::Sync),
            ..DurabilityConfig::default()
        }),
        ..NarsilConfig::default()
    };
    Ok(Some(DataNodeConfig::new(engine)))
}

#[cfg(unix)]
async fn stop_requested() -> Result<(), String> {
    use tokio::signal::unix::{SignalKind, signal};
    let mut terminate = signal(SignalKind::terminate()).map_err(|error| error.to_string())?;
    let mut interrupt = signal(SignalKind::interrupt()).map_err(|error| error.to_string())?;
    tokio::select! {
        _ = terminate.recv() => Ok(()),
        _ = interrupt.recv() => Ok(()),
    }
}

#[cfg(not(unix))]
async fn stop_requested() -> Result<(), String> {
    tokio::signal::ctrl_c()
        .await
        .map_err(|error| error.to_string())
}

fn node_config(
    node_id: &str,
    settings: &FaultNodeSettings,
    coordinator: &Arc<EtcdCoordinator>,
    transport: &Arc<dyn NodeTransport>,
) -> Result<ClusterNodeConfig, String> {
    let registration = NodeRegistration {
        node_id: node_id.to_string(),
        address: format!("{LISTEN_HOST}:{}", settings.advertised_port),
        roles: settings.roles.clone(),
        capacity: NodeCapacity::default(),
        started_at: next_started_at(),
        version: settings.version.clone(),
        extra: Map::new(),
    };
    let reporting_id = node_id.to_string();
    Ok(ClusterNodeConfig {
        controller: settings.controller,
        data: data_config(settings)?,
        backups: settings.backups.clone(),
        on_error: Some(Arc::new(move |error: &ClusterError| {
            eprintln!("{reporting_id}: {error}");
        })),
        ..ClusterNodeConfig::new(Arc::clone(coordinator), Arc::clone(transport), registration)
    })
}

async fn serve_node(node: &Arc<ClusterNode>, settings: &FaultNodeSettings) -> Result<(), String> {
    node.start().await.map_err(|error| error.to_string())?;
    let options = ServerOptions {
        host: Some(LISTEN_HOST.to_string()),
        port: Some(settings.http_port),
        ..ServerOptions::default()
    };
    let cluster_options = ClusterOptions {
        create_index: settings.create_index.clone(),
    };
    let server = NarsilServer::cluster(Arc::clone(node), cluster_options, options)
        .map_err(|error| error.to_string())?;
    let listened = server.listen().await.map_err(|error| error.to_string());
    if listened.is_ok() {
        println!("READY {}", node.node_id());
        stop_requested().await?;
    }
    let shut = server.shutdown().await.map_err(|error| error.to_string());
    listened.and(shut)
}

async fn serve() -> Result<(), String> {
    let settings = read_settings()?;
    let node_id = resolve_node_id(settings.node_id.as_deref(), settings.directory.as_deref())
        .map_err(|error| error.to_string())?;
    let coordinator = Arc::new(
        EtcdCoordinator::connect(settings.etcd.clone())
            .await
            .map_err(|error| error.to_string())?,
    );
    let transport = create_transport(&node_id, &settings)?;
    let config = node_config(&node_id, &settings, &coordinator, &transport)?;
    let node = Arc::new(ClusterNode::new(config).map_err(|error| error.to_string())?);
    let served = serve_node(&node, &settings).await;
    node.shutdown().await;
    transport.shutdown().await;
    coordinator.shutdown().await;
    served
}

#[tokio::main]
async fn main() -> ExitCode {
    match serve().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(failure) => {
            eprintln!("{failure}");
            ExitCode::FAILURE
        }
    }
}
