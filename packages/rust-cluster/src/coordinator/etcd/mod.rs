mod allocation;
mod client;
mod config;
mod endpoints;
mod keys;
mod leases;
mod registration;
mod requests;
mod timing;
mod values;
mod watch;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

pub use config::{EtcdAuthConfig, EtcdCoordinatorConfig, EtcdTlsConfig, WatchErrorHandler};
pub use timing::CoordinatorRequestFigure;
use etcd_client::{Compare, CompareOp, PutOptions, Txn, TxnOp};
pub use watch::WatchHandle;

use self::client::{WriteGuard, connect_and_probe};
use self::endpoints::EndpointPool;
use self::keys::{CoordinatorKeys, record_name};
use self::leases::{LeaseManager, ManagedLease};
use self::registration::{RegistrationKeys, write_node_registration};
use self::watch::{PrefixHandlers, watch_prefix, watcher_limit_error};
use super::serialization::decode_registration;
use super::types::{NodeEvent, NodeRegistration, RegistrationLease};
use super::validation::validate_node_id;
use crate::constants::MAX_WATCHERS;
use crate::error::{ClusterError, ClusterResult, codes};

type StopSender = tokio::sync::watch::Sender<bool>;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) struct Inner {
    pool: Arc<EndpointPool>,
    keys: CoordinatorKeys,
    guard: WriteGuard,
    leases: LeaseManager,
    lease_operations: tokio::sync::RwLock<()>,
    ttl_seconds: u64,
    closed: AtomicBool,
    watchers: Mutex<HashMap<u64, StopSender>>,
    next_watcher: AtomicU64,
    on_watch_error: Option<WatchErrorHandler>,
}

impl Inner {
    fn is_shut_down(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    fn ensure_open(&self) -> ClusterResult<()> {
        if self.is_shut_down() {
            return Err(ClusterError::new(
                codes::CONFIG_INVALID,
                "Coordinator has been shut down",
            ));
        }
        Ok(())
    }

    fn claim_watch_slot(&self, stop: StopSender) -> ClusterResult<u64> {
        let mut watchers = lock(&self.watchers);
        self.ensure_open()?;
        if watchers.len() >= MAX_WATCHERS {
            return Err(watcher_limit_error(watchers.len()));
        }
        let slot = self.next_watcher.fetch_add(1, Ordering::Relaxed);
        watchers.insert(slot, stop);
        Ok(slot)
    }

    fn release_watch_slot(&self, slot: u64) {
        lock(&self.watchers).remove(&slot);
    }
}

/// The coordinator backed by etcd, which stores a cluster's shared state across hosts and restarts, writing every
/// key and value as the TypeScript coordinator writes it.
///
/// etcd provides the two mechanisms that a cluster relies on: leases, which expire once a node misses its
/// heartbeats, and compare-and-set writes, which stop two controllers from writing conflicting state.
pub struct EtcdCoordinator {
    inner: Arc<Inner>,
}

impl EtcdCoordinator {
    /// Connects to etcd and reads from it once before it returns, so that a wrong certificate, a wrong password, or
    /// an etcd that nobody can reach fails this call.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` where `max_request_bytes` falls outside 1,025 to 2,147,483,647, where `tls` sets
    /// one of `cert` and `key` without the other or comes with an endpoint outside `https://`, or where `auth`
    /// would send its password over plain HTTP to an address other than a loopback one. Fails with
    /// `COORDINATOR_AUTH_FAILED` where etcd refuses the user or the password, and with `COORDINATOR_UNAVAILABLE`
    /// where no endpoint answers within 10 seconds or every endpoint fails the TLS handshake.
    pub async fn connect(config: EtcdCoordinatorConfig) -> ClusterResult<EtcdCoordinator> {
        config::validate(&config)?;
        let keys = CoordinatorKeys::new(&config.key_prefix);
        let pool = connect_and_probe(&config, &keys.node_prefix()).await?;
        let inner = Inner {
            pool: Arc::new(pool),
            keys,
            guard: WriteGuard::new(config.max_request_bytes),
            leases: LeaseManager::default(),
            lease_operations: tokio::sync::RwLock::new(()),
            ttl_seconds: config.node_heartbeat_ttl_seconds.max(1),
            closed: AtomicBool::new(false),
            watchers: Mutex::new(HashMap::new()),
            next_watcher: AtomicU64::new(0),
            on_watch_error: config.on_watch_error,
        };
        Ok(EtcdCoordinator {
            inner: Arc::new(inner),
        })
    }

    /// Writes `registration` under a lease that the coordinator keeps alive, together with the node's start time,
    /// and returns once etcd holds both.
    ///
    /// A call whose registration matches the one that the lease holds renews the lease alone, so that watchers see
    /// no change. Where etcd reports the lease lost, the coordinator writes the last registration again under a
    /// fresh lease, retrying until etcd accepts it.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` where the node id is empty, longer than 255 characters, or holds `/`, `\`, `..`,
    /// or a null byte, or where the request would pass `max_request_bytes`, and with `COORDINATOR_UNAVAILABLE` where
    /// etcd cannot be reached.
    pub async fn register_node(&self, registration: &NodeRegistration) -> ClusterResult<()> {
        let _active = self.inner.lease_operations.read().await;
        self.inner.ensure_open()?;
        validate_node_id(&registration.node_id)?;
        let keys = RegistrationKeys {
            key: self.inner.keys.node(&registration.node_id),
            started_at_key: self.inner.keys.node_started_at(&registration.node_id),
        };
        write_node_registration(&self.inner, keys, registration).await
    }

    /// Revokes the lease under the node's registration and deletes the registration and its start time.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` for an invalid node id, and with `COORDINATOR_UNAVAILABLE` where etcd cannot be
    /// reached.
    pub async fn deregister_node(&self, node_id: &str) -> ClusterResult<()> {
        let _active = self.inner.lease_operations.read().await;
        self.inner.ensure_open()?;
        validate_node_id(node_id)?;
        let key = self.inner.keys.node(node_id);
        let _exclusive = self.inner.leases.exclusively(&key).await;
        let entry = self.inner.leases.remove(&key);
        self.inner.leases.forget_holder(&key);
        if let Some(entry) = entry {
            entry.lease.revoke().await;
        }
        let txn = Txn::new()
            .when(vec![Compare::create_revision(
                key.clone(),
                CompareOp::Greater,
                -1,
            )])
            .and_then(vec![
                TxnOp::delete(self.inner.keys.node_started_at(node_id), None),
                TxnOp::delete(key, None),
            ]);
        self.inner.txn("deregisterNode", txn).await?;
        Ok(())
    }

    /// Returns how long the lease under the node's registration holds without another renewal, or `None` where
    /// this coordinator holds no lease for it.
    pub fn registration_lease(&self, node_id: &str) -> Option<RegistrationLease> {
        if self.inner.is_shut_down() {
            return None;
        }
        self.inner
            .leases
            .holder(&self.inner.keys.node(node_id))?
            .held_for()
    }

    /// Renews the lease under the node's registration once and returns how long it then holds, or `None` where this
    /// coordinator holds no lease for it.
    pub async fn confirm_registration_lease(&self, node_id: &str) -> Option<RegistrationLease> {
        if self.inner.is_shut_down() {
            return None;
        }
        let holder = self.inner.leases.holder(&self.inner.keys.node(node_id))?;
        let _ = holder.keepalive_once().await;
        holder.held_for()
    }

    /// Returns every node registration that etcd holds.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` where a stored registration cannot be read, and with `COORDINATOR_UNAVAILABLE`
    /// where etcd cannot be reached.
    pub async fn list_nodes(&self) -> ClusterResult<Vec<NodeRegistration>> {
        self.inner.ensure_open()?;
        let prefix = self.inner.keys.node_prefix();
        let listing = self
            .inner
            .get(
                "listNodes",
                prefix.as_bytes(),
                Some(etcd_client::GetOptions::new().with_prefix()),
            )
            .await?;
        listing
            .kvs()
            .iter()
            .filter(|entry| record_name(&String::from_utf8_lossy(entry.key()), &prefix).is_some())
            .map(|entry| decode_registration(entry.value()))
            .collect()
    }

    /// Calls `handler` with every change to the registered nodes until the returned handle stops the watch.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` after shutdown or where 64 watches already run, and with
    /// `COORDINATOR_UNAVAILABLE` where etcd cannot be reached.
    pub async fn watch_nodes<F>(&self, handler: F) -> ClusterResult<WatchHandle>
    where
        F: Fn(NodeEvent) + Send + Sync + 'static,
    {
        let prefix = self.inner.keys.node_prefix();
        let handler = Arc::new(handler);
        let on_put = Arc::clone(&handler);
        let put_prefix = prefix.clone();
        let deleted_prefix = prefix.clone();
        let handlers = PrefixHandlers {
            put: Box::new(move |key, value| {
                if record_name(key, &put_prefix).is_some() {
                    on_put(NodeEvent::Joined(decode_registration(value)?));
                }
                Ok(())
            }),
            delete: Box::new(move |key| {
                if let Some(node_id) = record_name(key, &deleted_prefix) {
                    handler(NodeEvent::Left(node_id.to_string()));
                }
                Ok(())
            }),
        };
        watch_prefix(&self.inner, prefix, handlers).await
    }

    /// Takes the lease `key` for `node_id`, which holds for `ttl_ms` rounded up to whole seconds, and returns
    /// whether `node_id` holds it, renewing it where `node_id` held it already.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` after shutdown, and with `COORDINATOR_UNAVAILABLE` where etcd cannot be reached.
    pub async fn acquire_lease(
        &self,
        key: &str,
        node_id: &str,
        ttl_ms: u64,
    ) -> ClusterResult<bool> {
        let _active = self.inner.lease_operations.read().await;
        self.inner.ensure_open()?;
        let etcd_key = self.inner.keys.lease(key);
        let _exclusive = self.inner.leases.exclusively(&etcd_key).await;
        let ttl_seconds = ttl_ms.div_ceil(1_000).max(1);
        if let Some(existing) = self
            .inner
            .leases
            .get(&etcd_key)
            .filter(|entry| entry.node_id == node_id)
        {
            if existing.lease.keepalive_once().await.is_ok() {
                return Ok(true);
            }
            self.inner.leases.remove(&etcd_key);
        }
        let lease = ManagedLease::grant(Arc::clone(&self.inner.pool), ttl_seconds).await?;
        let txn = Txn::new()
            .when(vec![Compare::create_revision(
                etcd_key.clone(),
                CompareOp::Equal,
                0,
            )])
            .and_then(vec![TxnOp::put(
                etcd_key.clone(),
                node_id.as_bytes().to_vec(),
                Some(PutOptions::new().with_lease(lease.id)),
            )]);
        let committed = match self.inner.txn("acquireLease", txn).await {
            Ok(response) => response.succeeded(),
            Err(error) => {
                lease.revoke().await;
                return Err(error);
            }
        };
        if !committed {
            lease.revoke().await;
            return Ok(self.lease_holder(key).await?.as_deref() == Some(node_id));
        }
        self.inner.leases.track(&etcd_key, lease, node_id, None);
        Ok(true)
    }

    /// Renews the lease `key` where `node_id` holds it through this coordinator, and returns whether it held.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` after shutdown.
    pub async fn renew_lease(&self, key: &str, node_id: &str) -> ClusterResult<bool> {
        let _active = self.inner.lease_operations.read().await;
        self.inner.ensure_open()?;
        let etcd_key = self.inner.keys.lease(key);
        let _exclusive = self.inner.leases.exclusively(&etcd_key).await;
        let Some(entry) = self.inner.leases.get_by_node_id(&etcd_key, node_id) else {
            return Ok(false);
        };
        if entry.lease.keepalive_once().await.is_ok() {
            return Ok(true);
        }
        self.inner.leases.remove(&etcd_key);
        Ok(false)
    }

    /// Revokes the lease `key` where this coordinator holds it.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` after shutdown.
    pub async fn release_lease(&self, key: &str) -> ClusterResult<()> {
        let _active = self.inner.lease_operations.read().await;
        self.inner.ensure_open()?;
        let etcd_key = self.inner.keys.lease(key);
        let _exclusive = self.inner.leases.exclusively(&etcd_key).await;
        if let Some(entry) = self.inner.leases.remove(&etcd_key) {
            entry.lease.revoke().await;
        }
        Ok(())
    }

    /// Returns the node id that holds the lease `key`, or `None` where nobody holds it.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` after shutdown, and with `COORDINATOR_UNAVAILABLE` where etcd cannot be reached.
    pub async fn lease_holder(&self, key: &str) -> ClusterResult<Option<String>> {
        self.inner.ensure_open()?;
        let found = self
            .inner
            .get("getLeaseHolder", self.inner.keys.lease(key), None)
            .await?;
        Ok(found
            .kvs()
            .first()
            .map(|entry| String::from_utf8_lossy(entry.value()).into_owned()))
    }

    /// Stops every watch, revokes every lease that this coordinator holds, and refuses every later call. A second
    /// call does nothing.
    pub async fn shutdown(&self) {
        if self.inner.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        let watchers: Vec<StopSender> = lock(&self.inner.watchers)
            .drain()
            .map(|(_, stop)| stop)
            .collect();
        for stop in watchers {
            stop.send_replace(true);
        }
        let _exclusive = self.inner.lease_operations.write().await;
        self.inner.leases.revoke_all().await;
    }
}
