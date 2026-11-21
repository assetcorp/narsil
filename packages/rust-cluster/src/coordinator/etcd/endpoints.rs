use std::future::Future;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use etcd_client::{Client, ConnectOptions, Error as EtcdError, KvClient, LeaseClient, WatchClient};
use tonic::Code;

use crate::constants::{
    ETCD_CALL_RETRIES, ETCD_CALL_TIMEOUT_MS, ETCD_ENDPOINT_FAILURE_THRESHOLD,
    ETCD_ENDPOINT_SKIP_MS, ETCD_MAX_RESPONSE_BYTES,
};

const LEASE_NOT_FOUND: &str = "lease not found";
const UNRECOVERABLE_ETCD_MESSAGES: [&str; 9] = [
    "etcdserver: role name already exists",
    "etcdserver: user name already exists",
    "etcdserver: role is not granted to the user",
    "etcdserver: role name not found",
    "etcdserver: user name not found",
    "etcdserver: authentication failed, invalid user ID or password",
    "etcdserver: permission denied",
    "etcdserver: invalid auth token",
    "etcdserver: requested lease not found",
];

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Clone)]
pub(crate) struct EndpointClients {
    pub(crate) kv: KvClient,
    pub(crate) lease: LeaseClient,
    pub(crate) watch: WatchClient,
}

pub(crate) enum CallFailure {
    Etcd(EtcdError),
    TimedOut,
    Skipped(String),
}

impl CallFailure {
    fn recoverable(&self) -> bool {
        match self {
            CallFailure::Etcd(error) => is_recoverable(error),
            CallFailure::TimedOut => true,
            CallFailure::Skipped(_) => false,
        }
    }
}

pub(crate) fn is_lease_not_found(error: &EtcdError) -> bool {
    matches!(error, EtcdError::LeaseKeepAliveError(text) if text.contains(LEASE_NOT_FOUND))
}

pub(crate) fn is_recoverable(error: &EtcdError) -> bool {
    match error {
        EtcdError::GRpcStatus(status) => {
            !UNRECOVERABLE_ETCD_MESSAGES
                .iter()
                .any(|text| status.message().contains(text))
                && matches!(
                    status.code(),
                    Code::Cancelled
                        | Code::Unknown
                        | Code::DeadlineExceeded
                        | Code::ResourceExhausted
                        | Code::Aborted
                        | Code::Internal
                        | Code::Unavailable
                )
        }
        EtcdError::LeaseKeepAliveError(_) => !is_lease_not_found(error),
        EtcdError::TransportError(_) | EtcdError::IoError(_) | EtcdError::WatchError(_) => true,
        _ => false,
    }
}

#[derive(Default)]
struct Breaker {
    consecutive_failures: u32,
    skipped_until: Option<Instant>,
}

struct Endpoint {
    url: String,
    clients: tokio::sync::Mutex<Option<EndpointClients>>,
    breaker: Mutex<Breaker>,
}

impl Endpoint {
    fn skip_reason(&self) -> Option<String> {
        let breaker = lock(&self.breaker);
        let skipped_until = breaker.skipped_until?;
        (Instant::now() < skipped_until).then(|| {
            format!(
                "etcd endpoint {} failed {ETCD_ENDPOINT_FAILURE_THRESHOLD} calls in a row, so this client skips it for {ETCD_ENDPOINT_SKIP_MS} ms",
                self.url
            )
        })
    }

    fn record(&self, failure: Option<&CallFailure>) {
        let mut breaker = lock(&self.breaker);
        match failure {
            None => breaker.consecutive_failures = 0,
            Some(failure) if failure.recoverable() => {
                breaker.consecutive_failures += 1;
                if breaker.consecutive_failures >= ETCD_ENDPOINT_FAILURE_THRESHOLD {
                    breaker.skipped_until =
                        Some(Instant::now() + Duration::from_millis(ETCD_ENDPOINT_SKIP_MS));
                }
            }
            Some(_) => {}
        }
    }
}

struct Shuffled {
    order: Vec<usize>,
    next: usize,
}

impl Shuffled {
    fn new(count: usize) -> Shuffled {
        Shuffled {
            order: (0..count).collect(),
            next: count,
        }
    }

    fn advance(&mut self) -> usize {
        if self.next == 0 {
            self.next = self.order.len();
        }
        self.next -= 1;
        let position = self.next;
        let chosen = random_below(position + 1);
        self.order.swap(chosen, position);
        self.order[position]
    }
}

fn random_below(bound: usize) -> usize {
    let mut bytes = [0u8; 8];
    if getrandom::fill(&mut bytes).is_err() {
        return bound.saturating_sub(1);
    }
    (u64::from_le_bytes(bytes) % bound as u64) as usize
}

pub(crate) struct Served<T> {
    pub(crate) value: T,
    pub(crate) endpoint: usize,
}

pub(crate) struct EndpointPool {
    endpoints: Vec<Endpoint>,
    options: ConnectOptions,
    watch_options: ConnectOptions,
}

impl EndpointPool {
    pub(crate) fn new(urls: &[String], options: ConnectOptions) -> EndpointPool {
        let endpoints = urls
            .iter()
            .map(|url| Endpoint {
                url: url.clone(),
                clients: tokio::sync::Mutex::new(None),
                breaker: Mutex::new(Breaker::default()),
            })
            .collect();
        EndpointPool {
            endpoints,
            watch_options: options.clone().with_require_leader(true),
            options,
        }
    }

    async fn clients(&self, endpoint: &Endpoint) -> Result<EndpointClients, EtcdError> {
        let mut cached = endpoint.clients.lock().await;
        if let Some(clients) = cached.as_ref() {
            return Ok(clients.clone());
        }
        let urls = [endpoint.url.as_str()];
        let plain = Client::connect(urls, Some(self.options.clone())).await?;
        let watching = Client::connect(urls, Some(self.watch_options.clone())).await?;
        let clients = EndpointClients {
            kv: plain
                .kv_client()
                .max_decoding_message_size(ETCD_MAX_RESPONSE_BYTES),
            lease: plain.lease_client(),
            watch: watching
                .watch_client()
                .max_decoding_message_size(ETCD_MAX_RESPONSE_BYTES),
        };
        *cached = Some(clients.clone());
        Ok(clients)
    }

    pub(crate) async fn report_failure(&self, endpoint: usize, failure: &CallFailure) {
        let Some(endpoint) = self.endpoints.get(endpoint) else {
            return;
        };
        endpoint.record(Some(failure));
        if failure.recoverable() {
            *endpoint.clients.lock().await = None;
        }
    }

    async fn once<T, F, Fut>(
        &self,
        order: &mut Shuffled,
        attempt: &F,
    ) -> Result<Served<T>, CallFailure>
    where
        F: Fn(EndpointClients) -> Fut,
        Fut: Future<Output = Result<T, EtcdError>>,
    {
        let mut skipped = None;
        for _ in 0..self.endpoints.len() {
            let index = order.advance();
            let Some(endpoint) = self.endpoints.get(index) else {
                continue;
            };
            if let Some(reason) = endpoint.skip_reason() {
                skipped = Some(reason);
                continue;
            }
            let call = async { attempt(self.clients(endpoint).await?).await };
            let failure =
                match tokio::time::timeout(Duration::from_millis(ETCD_CALL_TIMEOUT_MS), call).await
                {
                    Ok(Ok(value)) => {
                        endpoint.record(None);
                        return Ok(Served {
                            value,
                            endpoint: index,
                        });
                    }
                    Ok(Err(error)) => CallFailure::Etcd(error),
                    Err(_) => CallFailure::TimedOut,
                };
            self.report_failure(index, &failure).await;
            return Err(failure);
        }
        Err(CallFailure::Skipped(skipped.unwrap_or_else(|| {
            "the coordinator holds no etcd endpoint".to_string()
        })))
    }

    pub(crate) async fn serve<T, F, Fut>(&self, attempt: F) -> Result<Served<T>, CallFailure>
    where
        F: Fn(EndpointClients) -> Fut,
        Fut: Future<Output = Result<T, EtcdError>>,
    {
        let mut order = Shuffled::new(self.endpoints.len());
        let mut retries = 0;
        loop {
            match self.once(&mut order, &attempt).await {
                Err(failure) if failure.recoverable() && retries < ETCD_CALL_RETRIES => {
                    retries += 1
                }
                outcome => return outcome,
            }
        }
    }

    pub(crate) async fn run<T, F, Fut>(&self, attempt: F) -> Result<T, CallFailure>
    where
        F: Fn(EndpointClients) -> Fut,
        Fut: Future<Output = Result<T, EtcdError>>,
    {
        self.serve(attempt).await.map(|served| served.value)
    }
}
