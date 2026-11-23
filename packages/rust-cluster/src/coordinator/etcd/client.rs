use std::future::Future;
use std::time::{Duration, Instant};

use etcd_client::{Certificate, ConnectOptions, Error as EtcdError, Identity, TlsOptions};
use narsil::Value;
use tonic::Code;

use super::config::EtcdCoordinatorConfig;
use super::endpoints::{CallFailure, EndpointClients, EndpointPool};
use crate::constants::{
    ETCD_CALL_TIMEOUT_MS, ETCD_KEEPALIVE_TIME_MS, ETCD_KEEPALIVE_TIMEOUT_MS,
    ETCD_REQUEST_FRAMING_BYTES, ETCD_START_PROBE_TIMEOUT_MS,
};
use crate::error::{ClusterError, ClusterResult, codes};

const ETCD_REQUEST_TOO_LARGE: &str = "etcdserver: request is too large";
const GRPC_MESSAGE_TOO_LARGE: &str = "larger than max";
const REFUSED_CREDENTIAL_MESSAGES: [&str; 4] = [
    "authentication failed",
    "invalid auth token",
    "permission denied",
    "user name not found",
];

fn endpoint_values(config: &EtcdCoordinatorConfig) -> Value {
    Value::Array(
        config
            .endpoints
            .iter()
            .cloned()
            .map(Value::String)
            .collect(),
    )
}

fn refused_credentials(failure: &CallFailure) -> bool {
    match failure {
        CallFailure::Etcd(EtcdError::GRpcStatus(status)) => {
            status.code() == Code::Unauthenticated
                || REFUSED_CREDENTIAL_MESSAGES
                    .iter()
                    .any(|text| status.message().contains(text))
        }
        _ => false,
    }
}

fn describe(failure: &CallFailure) -> String {
    match failure {
        CallFailure::Etcd(error) => error.to_string(),
        CallFailure::TimedOut => format!("no answer within {ETCD_CALL_TIMEOUT_MS} ms"),
        CallFailure::Skipped(reason) => reason.clone(),
    }
}

fn connect_options(config: &EtcdCoordinatorConfig) -> ConnectOptions {
    let mut options = ConnectOptions::new()
        .with_keep_alive(
            Duration::from_millis(ETCD_KEEPALIVE_TIME_MS),
            Duration::from_millis(ETCD_KEEPALIVE_TIMEOUT_MS),
        )
        .with_connect_timeout(Duration::from_millis(ETCD_CALL_TIMEOUT_MS));
    if let Some(tls) = &config.tls {
        let mut tls_options = TlsOptions::new().ca_certificate(Certificate::from_pem(&tls.ca));
        if let (Some(cert), Some(key)) = (&tls.cert, &tls.key) {
            tls_options = tls_options.identity(Identity::from_pem(cert, key));
        }
        options = options.with_tls(tls_options);
    }
    if let Some(auth) = &config.auth {
        options = options
            .with_user(auth.username.clone(), auth.password.clone())
            .with_auto_token_refresh(true);
    }
    options
}

fn probe_failure(config: &EtcdCoordinatorConfig, failure: &CallFailure) -> ClusterError {
    if refused_credentials(failure) {
        return ClusterError::new(
            codes::COORDINATOR_AUTH_FAILED,
            "etcd refused the coordinator credentials",
        )
        .with_detail("endpoints", endpoint_values(config))
        .with_detail("cause", Value::String(describe(failure)));
    }
    ClusterError::new(
        codes::COORDINATOR_UNAVAILABLE,
        "The coordinator could not reach any etcd endpoint or complete a TLS handshake with one",
    )
    .with_detail("endpoints", endpoint_values(config))
    .with_detail("cause", Value::String(describe(failure)))
}

pub(crate) async fn connect_and_probe(
    config: &EtcdCoordinatorConfig,
    probe_key: &str,
) -> ClusterResult<EndpointPool> {
    let pool = EndpointPool::new(&config.endpoints, connect_options(config));
    let probe = pool.run(|mut clients: EndpointClients| {
        let key = probe_key.to_string();
        async move { clients.kv.get(key, None).await }
    });
    match tokio::time::timeout(Duration::from_millis(ETCD_START_PROBE_TIMEOUT_MS), probe).await {
        Ok(Ok(_)) => Ok(pool),
        Ok(Err(failure)) => Err(probe_failure(config, &failure)),
        Err(_) => Err(ClusterError::new(
            codes::COORDINATOR_UNAVAILABLE,
            format!("No etcd endpoint answered within {ETCD_START_PROBE_TIMEOUT_MS} ms"),
        )
        .with_detail("endpoints", endpoint_values(config))
        .with_detail(
            "timeoutMs",
            Value::Number(ETCD_START_PROBE_TIMEOUT_MS as f64),
        )),
    }
}

pub(crate) fn unreachable(operation: &str, failure: &CallFailure) -> ClusterError {
    let code = if refused_credentials(failure) {
        codes::COORDINATOR_AUTH_FAILED
    } else {
        codes::COORDINATOR_UNAVAILABLE
    };
    ClusterError::new(
        code,
        format!(
            "The coordinator reached no etcd endpoint for {operation}: {}",
            describe(failure)
        ),
    )
    .with_detail("operation", Value::String(operation.to_string()))
}

pub(crate) async fn call<T, F, Fut>(
    pool: &EndpointPool,
    operation: &str,
    attempt: F,
) -> ClusterResult<T>
where
    F: Fn(EndpointClients) -> Fut,
    Fut: Future<Output = Result<T, EtcdError>>,
{
    let started = Instant::now();
    let outcome = pool.run(attempt).await;
    pool.timing.record(operation, started.elapsed());
    outcome.map_err(|failure| unreachable(operation, &failure))
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct WriteGuard {
    max_request_bytes: usize,
}

pub(crate) struct EtcdWrite<'a> {
    pub(crate) key: &'a str,
    pub(crate) value_bytes: usize,
    pub(crate) expected_bytes: usize,
}

fn refused_for_size(failure: &CallFailure) -> bool {
    match failure {
        CallFailure::Etcd(EtcdError::GRpcStatus(status)) => match status.code() {
            Code::InvalidArgument => status.message().contains(ETCD_REQUEST_TOO_LARGE),
            Code::ResourceExhausted | Code::OutOfRange => {
                status.message().contains(GRPC_MESSAGE_TOO_LARGE)
            }
            _ => false,
        },
        _ => false,
    }
}

impl WriteGuard {
    pub(crate) fn new(max_request_bytes: usize) -> WriteGuard {
        WriteGuard { max_request_bytes }
    }

    pub(crate) fn require_fits(&self, write: &EtcdWrite<'_>) -> ClusterResult<usize> {
        let bytes = write.value_bytes
            + write.expected_bytes
            + 2 * write.key.len()
            + ETCD_REQUEST_FRAMING_BYTES;
        if bytes <= self.max_request_bytes {
            return Ok(bytes);
        }
        Err(ClusterError::new(
            codes::CONFIG_INVALID,
            format!(
                "The request to write \"{}\" would be {bytes} bytes, more than the maxRequestBytes of {}. Raise maxRequestBytes in createEtcdCoordinator together with the --max-request-bytes value of etcd.",
                write.key, self.max_request_bytes
            ),
        )
        .with_detail("key", Value::String(write.key.to_string()))
        .with_detail("bytes", Value::Number(bytes as f64))
        .with_detail("maxRequestBytes", Value::Number(self.max_request_bytes as f64)))
    }

    pub(crate) async fn send<T, F, Fut>(
        &self,
        pool: &EndpointPool,
        operation: &str,
        write: &EtcdWrite<'_>,
        attempt: F,
    ) -> ClusterResult<T>
    where
        F: Fn(EndpointClients) -> Fut,
        Fut: Future<Output = Result<T, EtcdError>>,
    {
        let bytes = self.require_fits(write)?;
        let started = Instant::now();
        let outcome = pool.run(attempt).await;
        pool.timing.record(operation, started.elapsed());
        match outcome {
            Ok(value) => Ok(value),
            Err(failure) if refused_for_size(&failure) => Err(ClusterError::new(
                codes::CONFIG_INVALID,
                format!(
                    "etcd reports the {bytes}-byte request to write \"{}\" as too large, so its --max-request-bytes value is below the maxRequestBytes of {}. Set both to the same value.",
                    write.key, self.max_request_bytes
                ),
            )
            .with_detail("key", Value::String(write.key.to_string()))
            .with_detail("bytes", Value::Number(bytes as f64))
            .with_detail("maxRequestBytes", Value::Number(self.max_request_bytes as f64))),
            Err(failure) => Err(unreachable(operation, &failure)),
        }
    }
}
