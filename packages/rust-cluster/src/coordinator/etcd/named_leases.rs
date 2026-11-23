use std::sync::Arc;

use etcd_client::{Compare, CompareOp, PutOptions, Txn, TxnOp};

use super::EtcdCoordinator;
use super::leases::ManagedLease;
use crate::error::ClusterResult;

impl EtcdCoordinator {
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
        self.timed("acquireLease", self.take_lease(key, node_id, ttl_ms))
            .await
    }

    async fn take_lease(&self, key: &str, node_id: &str, ttl_ms: u64) -> ClusterResult<bool> {
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
            return Ok(self.read_lease_holder(key).await?.as_deref() == Some(node_id));
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
        self.timed("renewLease", async {
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
        })
        .await
    }

    /// Revokes the lease `key` where this coordinator holds it.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` after shutdown.
    pub async fn release_lease(&self, key: &str) -> ClusterResult<()> {
        self.timed("releaseLease", async {
            let _active = self.inner.lease_operations.read().await;
            self.inner.ensure_open()?;
            let etcd_key = self.inner.keys.lease(key);
            let _exclusive = self.inner.leases.exclusively(&etcd_key).await;
            if let Some(entry) = self.inner.leases.remove(&etcd_key) {
                entry.lease.revoke().await;
            }
            Ok(())
        })
        .await
    }

    /// Returns the node id that holds the lease `key`, or `None` where nobody holds it.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` after shutdown, and with `COORDINATOR_UNAVAILABLE` where etcd cannot be reached.
    pub async fn lease_holder(&self, key: &str) -> ClusterResult<Option<String>> {
        self.timed("getLeaseHolder", self.read_lease_holder(key))
            .await
    }

    async fn read_lease_holder(&self, key: &str) -> ClusterResult<Option<String>> {
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
}
