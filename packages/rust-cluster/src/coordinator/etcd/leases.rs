use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

use etcd_client::{LeaseKeepAliveStream, LeaseKeeper};
use tokio::sync::{OwnedMutexGuard, watch};
use tokio::task::AbortHandle;

use super::client::{call, unreachable};
use super::endpoints::{CallFailure, EndpointPool, is_lease_not_found};
use crate::constants::{ETCD_CALL_TIMEOUT_MS, LEASE_RENEWALS_PER_TTL, RECONNECT_FIRST_DELAY_MS};
use crate::coordinator::types::RegistrationLease;
use crate::error::{ClusterError, ClusterResult, codes};

const MILLISECONDS_PER_SECOND: u64 = 1_000;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Clone, Copy)]
struct Validity {
    held_until: Instant,
    ttl: Duration,
}

pub(crate) struct ManagedLease {
    pub(crate) id: i64,
    ttl_seconds: u64,
    pool: Arc<EndpointPool>,
    validity: Mutex<Option<Validity>>,
    revoked: AtomicBool,
    lost: watch::Sender<bool>,
    renewing: Mutex<Option<AbortHandle>>,
}

enum Renewal {
    Held,
    Gone,
    Unanswered,
}

fn is_not_found(failure: &CallFailure) -> bool {
    matches!(failure, CallFailure::Etcd(error) if is_lease_not_found(error))
}

fn lost_error() -> ClusterError {
    ClusterError::new(
        codes::COORDINATOR_UNAVAILABLE,
        "etcd reports the lease as expired or revoked",
    )
}

struct OpenKeeper {
    keeper: LeaseKeeper,
    stream: LeaseKeepAliveStream,
    endpoint: usize,
}

async fn answer(open: &mut OpenKeeper) -> Result<Option<i64>, CallFailure> {
    let exchange = async {
        open.keeper.keep_alive().await?;
        open.stream.message().await
    };
    match tokio::time::timeout(Duration::from_millis(ETCD_CALL_TIMEOUT_MS), exchange).await {
        Ok(Ok(response)) => Ok(response.map(|response| response.ttl())),
        Ok(Err(error)) => Err(CallFailure::Etcd(error)),
        Err(_) => Err(CallFailure::TimedOut),
    }
}

fn judged(ttl: i64) -> Renewal {
    if ttl > 0 {
        Renewal::Held
    } else {
        Renewal::Gone
    }
}

async fn renew(pool: &EndpointPool, open: &mut Option<OpenKeeper>, id: i64) -> Renewal {
    if let Some(current) = open.as_mut() {
        match answer(current).await {
            Ok(Some(ttl)) => return judged(ttl),
            Ok(None) => {}
            Err(failure) => pool.report_failure(current.endpoint, &failure).await,
        }
        *open = None;
    }
    match pool
        .serve(|mut clients| async move { clients.lease.keep_alive(id).await })
        .await
    {
        Ok(served) => {
            let (keeper, stream) = served.value;
            *open = Some(OpenKeeper {
                keeper,
                stream,
                endpoint: served.endpoint,
            });
            Renewal::Held
        }
        Err(failure) if is_not_found(&failure) => Renewal::Gone,
        Err(_) => Renewal::Unanswered,
    }
}

async fn keep_renewing(
    lease: Weak<ManagedLease>,
    pool: Arc<EndpointPool>,
    id: i64,
    interval: Duration,
) {
    let mut open = None;
    let mut wait = interval;
    loop {
        tokio::time::sleep(wait).await;
        let Some(held) = lease.upgrade() else {
            return;
        };
        if held.is_revoked() {
            return;
        }
        let sent_at = Instant::now();
        match renew(&pool, &mut open, id).await {
            Renewal::Held => {
                held.record_renewal(sent_at, held.ttl_seconds);
                wait = interval;
            }
            Renewal::Gone => {
                held.mark_lost();
                return;
            }
            Renewal::Unanswered => {
                open = None;
                wait = Duration::from_millis(RECONNECT_FIRST_DELAY_MS).min(interval);
                if held.has_expired() {
                    held.mark_lost();
                    return;
                }
            }
        }
    }
}

impl ManagedLease {
    pub(crate) async fn grant(
        pool: Arc<EndpointPool>,
        ttl_seconds: u64,
    ) -> ClusterResult<Arc<ManagedLease>> {
        let sent_at = Instant::now();
        let ttl = ttl_seconds as i64;
        let granted = call(&pool, "grantLease", |mut clients| async move {
            clients.lease.grant(ttl, None).await
        })
        .await?;
        let lease = Arc::new(ManagedLease {
            id: granted.id(),
            ttl_seconds,
            pool: Arc::clone(&pool),
            validity: Mutex::new(None),
            revoked: AtomicBool::new(false),
            lost: watch::channel(false).0,
            renewing: Mutex::new(None),
        });
        lease.record_renewal(sent_at, ttl_seconds);
        let interval = Duration::from_millis(
            (ttl_seconds * MILLISECONDS_PER_SECOND / u64::from(LEASE_RENEWALS_PER_TTL)).max(1),
        );
        let renewing = tokio::spawn(keep_renewing(
            Arc::downgrade(&lease),
            pool,
            lease.id,
            interval,
        ));
        *lock(&lease.renewing) = Some(renewing.abort_handle());
        Ok(lease)
    }

    fn record_renewal(&self, sent_at: Instant, ttl_seconds: u64) {
        if ttl_seconds == 0 {
            return;
        }
        let ttl = Duration::from_millis(ttl_seconds * MILLISECONDS_PER_SECOND);
        let held_until = sent_at + ttl;
        let mut validity = lock(&self.validity);
        if validity.is_some_and(|current| current.held_until >= held_until) {
            return;
        }
        *validity = Some(Validity { held_until, ttl });
    }

    fn has_expired(&self) -> bool {
        lock(&self.validity).is_none_or(|validity| Instant::now() >= validity.held_until)
    }

    fn mark_lost(&self) {
        *lock(&self.validity) = None;
        self.lost.send_replace(true);
    }

    pub(crate) fn is_revoked(&self) -> bool {
        self.revoked.load(Ordering::Acquire)
    }

    pub(crate) fn lost(&self) -> watch::Receiver<bool> {
        self.lost.subscribe()
    }

    pub(crate) async fn keepalive_once(&self) -> ClusterResult<()> {
        let sent_at = Instant::now();
        let id = self.id;
        let renewal = self
            .pool
            .run(|mut clients| async move { clients.lease.keep_alive(id).await })
            .await;
        match renewal {
            Ok(_) => {
                self.record_renewal(sent_at, self.ttl_seconds);
                Ok(())
            }
            Err(failure) => Err(lease_error("keepaliveLease", &failure)),
        }
    }

    pub(crate) async fn revoke(&self) {
        self.revoked.store(true, Ordering::Release);
        if let Some(renewing) = lock(&self.renewing).take() {
            renewing.abort();
        }
        *lock(&self.validity) = None;
        let id = self.id;
        let _ = call(&self.pool, "revokeLease", |mut clients| async move {
            clients.lease.revoke(id).await
        })
        .await;
    }

    pub(crate) fn held_for(&self) -> Option<RegistrationLease> {
        if self.is_revoked() {
            return None;
        }
        let validity = (*lock(&self.validity))?;
        let now = Instant::now();
        let remaining_ms = if validity.held_until >= now {
            validity.held_until.duration_since(now).as_secs_f64() * 1_000.0
        } else {
            -(now.duration_since(validity.held_until).as_secs_f64() * 1_000.0)
        };
        Some(RegistrationLease {
            remaining_ms,
            ttl_ms: validity.ttl.as_millis() as f64,
        })
    }
}

impl Drop for ManagedLease {
    fn drop(&mut self) {
        if let Some(renewing) = lock(&self.renewing).take() {
            renewing.abort();
        }
    }
}

pub(crate) fn lease_error(operation: &str, failure: &CallFailure) -> ClusterError {
    if is_not_found(failure) {
        return lost_error();
    }
    unreachable(operation, failure)
}

#[derive(Clone)]
pub(crate) struct Tracked {
    pub(crate) lease: Arc<ManagedLease>,
    pub(crate) node_id: String,
    pub(crate) payload: Option<Vec<u8>>,
}

#[derive(Default)]
pub(crate) struct LeaseManager {
    leases: Mutex<HashMap<String, Tracked>>,
    holders: Mutex<HashMap<String, Arc<ManagedLease>>>,
    key_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl LeaseManager {
    pub(crate) fn track(
        &self,
        key: &str,
        lease: Arc<ManagedLease>,
        node_id: &str,
        payload: Option<Vec<u8>>,
    ) {
        lock(&self.holders).insert(key.to_string(), Arc::clone(&lease));
        lock(&self.leases).insert(
            key.to_string(),
            Tracked {
                lease,
                node_id: node_id.to_string(),
                payload,
            },
        );
    }

    pub(crate) fn holder(&self, key: &str) -> Option<Arc<ManagedLease>> {
        lock(&self.holders).get(key).cloned()
    }

    pub(crate) fn forget_holder(&self, key: &str) {
        lock(&self.holders).remove(key);
    }

    pub(crate) fn get(&self, key: &str) -> Option<Tracked> {
        lock(&self.leases).get(key).cloned()
    }

    pub(crate) fn get_by_node_id(&self, key: &str, node_id: &str) -> Option<Tracked> {
        self.get(key).filter(|tracked| tracked.node_id == node_id)
    }

    pub(crate) fn holds_payload(&self, key: &str, payload: &[u8]) -> bool {
        lock(&self.leases)
            .get(key)
            .is_some_and(|tracked| tracked.payload.as_deref() == Some(payload))
    }

    pub(crate) fn remove(&self, key: &str) -> Option<Tracked> {
        lock(&self.leases).remove(key)
    }

    pub(crate) async fn exclusively(&self, key: &str) -> OwnedMutexGuard<()> {
        let held = {
            let mut locks = lock(&self.key_locks);
            locks.retain(|_, held| Arc::strong_count(held) > 1);
            Arc::clone(locks.entry(key.to_string()).or_default())
        };
        held.lock_owned().await
    }

    pub(crate) async fn revoke_all(&self) {
        let tracked: Vec<Tracked> = lock(&self.leases)
            .drain()
            .map(|(_, tracked)| tracked)
            .collect();
        lock(&self.holders).clear();
        for entry in tracked {
            entry.lease.revoke().await;
        }
    }
}
