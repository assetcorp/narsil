use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use narsil::{DurabilityConfig, DurabilityMode, Map, NarsilConfig, Value, parse_plain_json};
use narsil_cluster::SPEC_VERSION;
use narsil_cluster::coordinator::etcd::{
    EtcdAuthConfig, EtcdCoordinator, EtcdCoordinatorConfig, EtcdTlsConfig,
};
use narsil_cluster::coordinator::{NodeCapacity, NodeRegistration};
use narsil_cluster::error::ClusterError;
use narsil_cluster::node::{
    ClusterNode, ClusterNodeConfig, ControllerTiming, DataNodeConfig, next_started_at,
    resolve_node_id,
};
use narsil_cluster::transport::grpc::{GrpcTransport, GrpcTransportConfig};
use narsil_cluster::transport::tcp::{TcpTransport, TcpTransportConfig};
use narsil_cluster::transport::{NodeTransport, TlsConfig};

const SETTINGS_VARIABLE: &str = "NARSIL_FAULT_NODE";
const LISTEN_HOST: &str = "127.0.0.1";
const GRPC_TRANSPORT: &str = "grpc";
const COORDINATOR_ROLE: &str = "coordinator";
const DATA_ROLE: &str = "data";
const ENGINE_DIRECTORY: &str = "engine";
const SPOOL_DIRECTORY: &str = "spool";

struct FaultNodeSettings {
    etcd: EtcdCoordinatorConfig,
    transport_port: u16,
    advertised_port: u16,
    directory: Option<PathBuf>,
    node_id: Option<String>,
    roles: Vec<String>,
    version: String,
    controller: ControllerTiming,
    grpc: bool,
    transport_tls: Option<TlsConfig>,
}

fn field<'a>(settings: &'a Map, key: &str) -> Option<&'a Value> {
    settings
        .get(key)
        .filter(|value| !matches!(value, Value::Null))
}

fn text(settings: &Map, key: &str) -> Result<Option<String>, String> {
    match field(settings, key) {
        None => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(format!("{SETTINGS_VARIABLE}.{key} must be a string")),
    }
}

fn required_text(settings: &Map, key: &str) -> Result<String, String> {
    text(settings, key)?.ok_or_else(|| format!("{SETTINGS_VARIABLE}.{key} is required"))
}

fn whole_number(settings: &Map, key: &str, largest: f64) -> Result<f64, String> {
    match field(settings, key).and_then(Value::as_f64) {
        Some(value) if value.fract() == 0.0 && (0.0..=largest).contains(&value) => Ok(value),
        _ => Err(format!(
            "{SETTINGS_VARIABLE}.{key} must be a whole number from 0 to {largest}"
        )),
    }
}

fn port(settings: &Map, key: &str) -> Result<u16, String> {
    Ok(whole_number(settings, key, f64::from(u16::MAX))? as u16)
}

fn strings(settings: &Map, key: &str) -> Result<Vec<String>, String> {
    match field(settings, key) {
        None => Ok(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_string)
                    .ok_or_else(|| format!("{SETTINGS_VARIABLE}.{key} must hold strings alone"))
            })
            .collect(),
        Some(_) => Err(format!(
            "{SETTINGS_VARIABLE}.{key} must be a list of strings"
        )),
    }
}

fn object<'a>(settings: &'a Map, key: &str) -> Result<Option<&'a Map>, String> {
    match field(settings, key) {
        None => Ok(None),
        Some(Value::Object(inner)) => Ok(Some(inner)),
        Some(_) => Err(format!("{SETTINGS_VARIABLE}.{key} must be an object")),
    }
}

fn etcd_tls(settings: &Map) -> Result<Option<EtcdTlsConfig>, String> {
    let Some(tls) = object(settings, "etcdTls")? else {
        return Ok(None);
    };
    Ok(Some(EtcdTlsConfig {
        ca: required_text(tls, "ca")?.into_bytes(),
        cert: text(tls, "cert")?.map(String::into_bytes),
        key: text(tls, "key")?.map(String::into_bytes),
    }))
}

fn etcd_auth(settings: &Map) -> Result<Option<EtcdAuthConfig>, String> {
    let Some(auth) = object(settings, "etcdAuth")? else {
        return Ok(None);
    };
    Ok(Some(EtcdAuthConfig {
        username: required_text(auth, "username")?,
        password: required_text(auth, "password")?,
    }))
}

fn transport_tls(settings: &Map) -> Result<Option<TlsConfig>, String> {
    let Some(tls) = object(settings, "transportTls")? else {
        return Ok(None);
    };
    Ok(Some(TlsConfig {
        cert: required_text(tls, "cert")?.into_bytes(),
        key: required_text(tls, "key")?.into_bytes(),
        ca: required_text(tls, "ca")?.into_bytes(),
    }))
}

fn milliseconds(settings: &Map, key: &str, default: u64) -> Result<u64, String> {
    if field(settings, key).is_none() {
        return Ok(default);
    }
    Ok(whole_number(settings, key, f64::from(u32::MAX))? as u64)
}

fn controller_timing(settings: &Map) -> Result<ControllerTiming, String> {
    let defaults = ControllerTiming::default();
    Ok(ControllerTiming {
        lease_ttl_ms: milliseconds(settings, "controllerLeaseTtlMs", defaults.lease_ttl_ms)?,
        standby_retry_ms: milliseconds(settings, "standbyRetryMs", defaults.standby_retry_ms)?,
        node_left_delay_ms: milliseconds(settings, "nodeLeftDelayMs", defaults.node_left_delay_ms)?,
    })
}

fn read_settings() -> Result<FaultNodeSettings, String> {
    let raw =
        std::env::var(SETTINGS_VARIABLE).map_err(|_| format!("{SETTINGS_VARIABLE} is not set"))?;
    let Value::Object(settings) = parse_plain_json(&raw).map_err(|error| error.to_string())? else {
        return Err(format!("{SETTINGS_VARIABLE} must hold a JSON object"));
    };
    let mut etcd = EtcdCoordinatorConfig {
        endpoints: strings(&settings, "etcdEndpoints")?,
        tls: etcd_tls(&settings)?,
        auth: etcd_auth(&settings)?,
        ..EtcdCoordinatorConfig::default()
    };
    if let Some(key_prefix) = text(&settings, "keyPrefix")? {
        etcd.key_prefix = key_prefix;
    }
    if field(&settings, "heartbeatTtlSeconds").is_some() {
        etcd.node_heartbeat_ttl_seconds =
            whole_number(&settings, "heartbeatTtlSeconds", f64::from(u32::MAX))? as u64;
    }
    let transport = text(&settings, "transport")?;
    Ok(FaultNodeSettings {
        etcd,
        transport_port: port(&settings, "transportPort")?,
        advertised_port: port(&settings, "advertisedPort")?,
        directory: text(&settings, "directory")?.map(PathBuf::from),
        node_id: text(&settings, "nodeId")?,
        roles: match field(&settings, "roles") {
            None => vec![COORDINATOR_ROLE.to_string()],
            Some(_) => strings(&settings, "roles")?,
        },
        version: text(&settings, "version")?.unwrap_or_else(|| SPEC_VERSION.to_string()),
        controller: controller_timing(&settings)?,
        grpc: transport.as_deref() == Some(GRPC_TRANSPORT),
        transport_tls: transport_tls(&settings)?,
    })
}

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
    let (engine_directory, spool_directory) = (
        directory.join(ENGINE_DIRECTORY),
        directory.join(SPOOL_DIRECTORY),
    );
    for created in [&engine_directory, &spool_directory] {
        std::fs::create_dir_all(created).map_err(|error| error.to_string())?;
    }
    let engine = NarsilConfig {
        durability: Some(DurabilityConfig {
            directory: Some(engine_directory),
            mode: Some(DurabilityMode::Sync),
            ..DurabilityConfig::default()
        }),
        ..NarsilConfig::default()
    };
    Ok(Some(DataNodeConfig {
        snapshot_spool_directory: Some(spool_directory),
        ..DataNodeConfig::new(engine)
    }))
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
    let registration = NodeRegistration {
        node_id: node_id.clone(),
        address: format!("{LISTEN_HOST}:{}", settings.advertised_port),
        roles: settings.roles.clone(),
        capacity: NodeCapacity::default(),
        started_at: next_started_at(),
        version: settings.version.clone(),
        extra: Map::new(),
    };
    let reporting_id = node_id.clone();
    let config = ClusterNodeConfig {
        controller: settings.controller,
        on_error: Some(Arc::new(move |error: &ClusterError| {
            eprintln!("{reporting_id}: {error}");
        })),
        ..ClusterNodeConfig::new(
            Arc::clone(&coordinator),
            Arc::clone(&transport),
            registration,
        )
    };
    let config = ClusterNodeConfig {
        data: data_config(&settings)?,
        ..config
    };
    let node = ClusterNode::new(config).map_err(|error| error.to_string())?;
    let started = node.start().await;
    if started.is_ok() {
        println!("READY {node_id}");
        stop_requested().await?;
    }
    node.shutdown().await;
    transport.shutdown().await;
    coordinator.shutdown().await;
    started.map_err(|error| error.to_string())
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
