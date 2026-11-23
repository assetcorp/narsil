use std::path::PathBuf;
use std::sync::Arc;

use narsil::{FilesystemPersistence, Map, Value, parse_plain_json};
use narsil_cluster::SPEC_VERSION;
use narsil_cluster::coordinator::etcd::{EtcdAuthConfig, EtcdCoordinatorConfig, EtcdTlsConfig};
use narsil_cluster::node::{ClusterBackupConfig, ControllerTiming, CreateIndexOptions};
use narsil_cluster::transport::TlsConfig;

const SETTINGS_VARIABLE: &str = "NARSIL_FAULT_NODE";
const GRPC_TRANSPORT: &str = "grpc";
const DEFAULT_ROLES: [&str; 3] = ["data", "coordinator", "controller"];

pub(crate) struct FaultNodeSettings {
    pub(crate) etcd: EtcdCoordinatorConfig,
    pub(crate) http_port: u16,
    pub(crate) transport_port: u16,
    pub(crate) advertised_port: u16,
    pub(crate) directory: Option<PathBuf>,
    pub(crate) node_id: Option<String>,
    pub(crate) roles: Vec<String>,
    pub(crate) version: String,
    pub(crate) controller: ControllerTiming,
    pub(crate) grpc: bool,
    pub(crate) transport_tls: Option<TlsConfig>,
    pub(crate) create_index: CreateIndexOptions,
    pub(crate) backups: Option<ClusterBackupConfig>,
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

fn optional_count(settings: &Map, key: &str) -> Result<Option<u32>, String> {
    if field(settings, key).is_none() {
        return Ok(None);
    }
    Ok(Some(
        whole_number(settings, key, f64::from(u32::MAX))? as u32
    ))
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

fn create_index(settings: &Map) -> Result<CreateIndexOptions, String> {
    Ok(CreateIndexOptions {
        partition_count: optional_count(settings, "partitionCount")?,
        replication_factor: optional_count(settings, "replicationFactor")?,
        wait_for_serving_ms: match field(settings, "waitForServingMs") {
            None => None,
            Some(_) => Some(milliseconds(settings, "waitForServingMs", 0)?),
        },
    })
}

fn backups(settings: &Map) -> Result<Option<ClusterBackupConfig>, String> {
    let Some(directory) = text(settings, "backupDirectory")? else {
        return Ok(None);
    };
    let store = FilesystemPersistence::new(&directory).map_err(|error| error.to_string())?;
    Ok(Some(ClusterBackupConfig {
        store: Arc::new(store),
        key_prefix: required_text(settings, "backupKeyPrefix")?,
    }))
}

pub(crate) fn read_settings() -> Result<FaultNodeSettings, String> {
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
        http_port: port(&settings, "httpPort")?,
        transport_port: port(&settings, "transportPort")?,
        advertised_port: port(&settings, "advertisedPort")?,
        directory: text(&settings, "directory")?.map(PathBuf::from),
        node_id: text(&settings, "nodeId")?,
        roles: match field(&settings, "roles") {
            None => DEFAULT_ROLES.iter().map(|role| role.to_string()).collect(),
            Some(_) => strings(&settings, "roles")?,
        },
        version: text(&settings, "version")?.unwrap_or_else(|| SPEC_VERSION.to_string()),
        controller: controller_timing(&settings)?,
        grpc: transport.as_deref() == Some(GRPC_TRANSPORT),
        transport_tls: transport_tls(&settings)?,
        create_index: create_index(&settings)?,
        backups: backups(&settings)?,
    })
}
