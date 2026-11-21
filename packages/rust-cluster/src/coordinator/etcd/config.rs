use std::sync::Arc;

use narsil::Value;

use crate::constants::{
    DEFAULT_ETCD_ENDPOINT, DEFAULT_ETCD_KEY_PREFIX, DEFAULT_ETCD_MAX_REQUEST_BYTES,
    DEFAULT_NODE_HEARTBEAT_TTL_SECONDS, ETCD_REQUEST_FRAMING_BYTES, MAX_ETCD_REQUEST_BYTES,
};
use crate::error::{ClusterError, ClusterResult, ClusterResult as Result, codes};

const SECURE_SCHEME: &str = "https://";

/// The certificates that the coordinator uses to reach etcd over TLS, each in PEM form.
#[derive(Clone)]
pub struct EtcdTlsConfig {
    /// The authority that every etcd member's certificate must chain to.
    pub ca: Vec<u8>,
    /// The client certificate that the coordinator presents to an etcd that asks for one, set together with `key`.
    pub cert: Option<Vec<u8>>,
    /// The private key of `cert`.
    pub key: Option<Vec<u8>>,
}

impl std::fmt::Debug for EtcdTlsConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("EtcdTlsConfig")
            .field("ca", &format_args!("{} bytes", self.ca.len()))
            .field("cert", &self.cert.as_ref().map(Vec::len))
            .field("key", &self.key.as_ref().map(|_| "redacted"))
            .finish()
    }
}

/// The etcd user that the coordinator signs in as.
#[derive(Clone)]
pub struct EtcdAuthConfig {
    /// The user name.
    pub username: String,
    /// The user's password.
    pub password: String,
}

impl std::fmt::Debug for EtcdAuthConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("EtcdAuthConfig")
            .field("username", &self.username)
            .field("password", &"redacted")
            .finish()
    }
}

/// Receives every error that the coordinator meets while it delivers a watched change, such as a value under a
/// watched prefix that it cannot read, which the coordinator then skips.
pub type WatchErrorHandler = Arc<dyn Fn(ClusterError) + Send + Sync>;

/// Where the coordinator connects, how long etcd keeps a node's registration, and how large a request the
/// coordinator sends.
#[derive(Clone)]
pub struct EtcdCoordinatorConfig {
    /// The etcd endpoints, such as `http://localhost:2379`.
    pub endpoints: Vec<String>,
    /// The prefix of every key that the coordinator writes, so that one etcd cluster can store several Narsil
    /// clusters.
    pub key_prefix: String,
    /// The seconds that etcd keeps a node's registration without a heartbeat.
    pub node_heartbeat_ttl_seconds: u64,
    /// The largest request, in bytes, that the coordinator sends, which should equal the `--max-request-bytes` value
    /// of every etcd member.
    pub max_request_bytes: usize,
    /// The certificates that make the coordinator reach etcd over TLS, which needs every endpoint to start with
    /// `https://`.
    pub tls: Option<EtcdTlsConfig>,
    /// The etcd user that the coordinator signs in as, whose password travels over TLS, or over plain HTTP to a
    /// loopback address alone.
    pub auth: Option<EtcdAuthConfig>,
    /// Receives each error that a watched change raises.
    pub on_watch_error: Option<WatchErrorHandler>,
}

impl std::fmt::Debug for EtcdCoordinatorConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("EtcdCoordinatorConfig")
            .field("endpoints", &self.endpoints)
            .field("key_prefix", &self.key_prefix)
            .field(
                "node_heartbeat_ttl_seconds",
                &self.node_heartbeat_ttl_seconds,
            )
            .field("max_request_bytes", &self.max_request_bytes)
            .field("tls", &self.tls)
            .field("auth", &self.auth)
            .finish_non_exhaustive()
    }
}

impl Default for EtcdCoordinatorConfig {
    fn default() -> EtcdCoordinatorConfig {
        EtcdCoordinatorConfig {
            endpoints: vec![DEFAULT_ETCD_ENDPOINT.to_string()],
            key_prefix: DEFAULT_ETCD_KEY_PREFIX.to_string(),
            node_heartbeat_ttl_seconds: DEFAULT_NODE_HEARTBEAT_TTL_SECONDS,
            max_request_bytes: DEFAULT_ETCD_MAX_REQUEST_BYTES,
            tls: None,
            auth: None,
            on_watch_error: None,
        }
    }
}

fn refuse(message: &str) -> ClusterError {
    ClusterError::new(codes::CONFIG_INVALID, message)
}

fn endpoint_list(endpoints: &[&String]) -> Value {
    Value::Array(
        endpoints
            .iter()
            .map(|endpoint| Value::String((*endpoint).clone()))
            .collect(),
    )
}

fn hostname_of(endpoint: &str) -> Option<String> {
    let lower = endpoint.to_ascii_lowercase();
    let after_scheme = match lower.find("://") {
        Some(at) => &lower[at + 3..],
        None => lower.as_str(),
    };
    let authority = after_scheme.split(['/', '?', '#']).next()?;
    let host_and_port = authority.rsplit('@').next()?;
    if let Some(bracketed) = host_and_port.strip_prefix('[') {
        let end = bracketed.find(']')?;
        return Some(format!("[{}]", &bracketed[..end]));
    }
    let host = host_and_port.split(':').next()?;
    (!host.is_empty()).then(|| host.to_string())
}

fn is_loopback(endpoint: &str) -> bool {
    let Some(hostname) = hostname_of(endpoint) else {
        return false;
    };
    if hostname == "localhost" || hostname == "[::1]" {
        return true;
    }
    let octets: Vec<&str> = hostname.split('.').collect();
    octets.len() == 4
        && octets[0] == "127"
        && octets.iter().all(|octet| {
            (1..=3).contains(&octet.len()) && octet.bytes().all(|byte| byte.is_ascii_digit())
        })
}

fn validate_max_request_bytes(max_request_bytes: usize) -> Result<()> {
    if max_request_bytes > ETCD_REQUEST_FRAMING_BYTES && max_request_bytes <= MAX_ETCD_REQUEST_BYTES
    {
        return Ok(());
    }
    Err(refuse(&format!(
        "maxRequestBytes must be a whole number above {ETCD_REQUEST_FRAMING_BYTES} and at most {MAX_ETCD_REQUEST_BYTES}"
    ))
    .with_detail("maxRequestBytes", Value::Number(max_request_bytes as f64)))
}

fn validate_tls(config: &EtcdCoordinatorConfig) -> Result<()> {
    let Some(tls) = &config.tls else {
        return Ok(());
    };
    if tls.cert.is_some() != tls.key.is_some() {
        return Err(refuse(
            "etcd tls needs both cert and key to present a client certificate, or neither",
        ));
    }
    let plain: Vec<&String> = config
        .endpoints
        .iter()
        .filter(|endpoint| !endpoint.starts_with(SECURE_SCHEME))
        .collect();
    if !plain.is_empty() {
        return Err(
            refuse("Every etcd endpoint must start with https:// when tls is set")
                .with_detail("endpoints", endpoint_list(&plain)),
        );
    }
    Ok(())
}

fn validate_auth(config: &EtcdCoordinatorConfig) -> Result<()> {
    let Some(auth) = &config.auth else {
        return Ok(());
    };
    if auth.username.is_empty() || auth.password.is_empty() {
        return Err(refuse(
            "etcd auth needs a username and a password that are not empty",
        ));
    }
    let exposed: Vec<&String> = config
        .endpoints
        .iter()
        .filter(|endpoint| !endpoint.starts_with(SECURE_SCHEME) && !is_loopback(endpoint))
        .collect();
    if !exposed.is_empty() {
        return Err(refuse(
            "etcd auth sends its password over https://, or over http:// to a loopback address alone",
        )
        .with_detail("endpoints", endpoint_list(&exposed)));
    }
    Ok(())
}

pub(crate) fn validate(config: &EtcdCoordinatorConfig) -> ClusterResult<()> {
    validate_max_request_bytes(config.max_request_bytes)?;
    if config.endpoints.is_empty() {
        return Err(refuse("The coordinator needs at least one etcd endpoint"));
    }
    validate_tls(config)?;
    validate_auth(config)
}
