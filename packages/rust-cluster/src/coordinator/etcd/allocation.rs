use std::sync::Arc;

use etcd_client::{Compare, CompareOp, GetOptions, Txn, TxnOp};

use super::EtcdCoordinator;
use super::client::EtcdWrite;
use super::keys::record_name;
use super::watch::{PrefixHandlers, WatchHandle, watch_prefix};
use crate::constants::CONTROLLER_LEASE_KEY;
use crate::coordinator::serialization::{decode_allocation, encode_allocation};
use crate::coordinator::types::{AllocationTable, ExpectedReplicaRegistration, PartitionState};
use crate::coordinator::validation::is_valid_node_id;
use crate::error::ClusterResult;

const PUT_ALLOCATION: &str = "putAllocation";

impl EtcdCoordinator {
    /// Returns the allocation table of `index_name`, or `None` where etcd holds none.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` where the stored table cannot be read, and with `COORDINATOR_UNAVAILABLE` where
    /// etcd cannot be reached.
    pub async fn allocation(&self, index_name: &str) -> ClusterResult<Option<AllocationTable>> {
        self.inner.ensure_open()?;
        let found = self
            .inner
            .get(
                "getAllocation",
                self.inner.keys.allocation(index_name),
                None,
            )
            .await?;
        found
            .kvs()
            .first()
            .map(|entry| decode_allocation(entry.value()))
            .transpose()
    }

    /// Writes the allocation table of `index_name` with no condition.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` where the request would pass `max_request_bytes`, and with
    /// `COORDINATOR_UNAVAILABLE` where etcd cannot be reached.
    pub async fn put_allocation(
        &self,
        index_name: &str,
        table: &AllocationTable,
    ) -> ClusterResult<()> {
        self.inner.ensure_open()?;
        let key = self.inner.keys.allocation(index_name);
        let data = encode_allocation(table)?;
        let write = EtcdWrite {
            key: &key,
            value_bytes: data.len(),
            expected_bytes: 0,
        };
        self.inner.guarded_put(PUT_ALLOCATION, &write, data).await?;
        Ok(())
    }

    /// Writes the allocation table of `index_name` only while `writer_node_id` holds the controller lease, while
    /// the stored table's version equals `expected_version`, or while no table exists where it is `None`, and,
    /// where `replica` is given, only while that replica's registration holds the start time that it names.
    /// Returns whether etcd took the write.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` where the request would pass `max_request_bytes` or the stored table cannot be
    /// read, and with `COORDINATOR_UNAVAILABLE` where etcd cannot be reached.
    pub async fn put_allocation_guarded(
        &self,
        index_name: &str,
        table: &AllocationTable,
        expected_version: Option<f64>,
        writer_node_id: &str,
        replica: Option<&ExpectedReplicaRegistration>,
    ) -> ClusterResult<bool> {
        self.inner.ensure_open()?;
        if writer_node_id.is_empty()
            || replica.is_some_and(|replica| !is_valid_node_id(&replica.node_id))
        {
            return Ok(false);
        }
        let key = self.inner.keys.allocation(index_name);
        let data = encode_allocation(table)?;
        let first = match expected_version {
            None => Compare::create_revision(key.clone(), CompareOp::Equal, 0),
            Some(expected) => {
                let found = self.inner.get("getAllocation", key.clone(), None).await?;
                let Some(stored) = found.kvs().first() else {
                    return Ok(false);
                };
                if decode_allocation(stored.value())?.version != expected {
                    return Ok(false);
                }
                Compare::mod_revision(key.clone(), CompareOp::Equal, stored.mod_revision())
            }
        };
        let mut compares = vec![
            first,
            Compare::value(
                self.inner.keys.lease(CONTROLLER_LEASE_KEY),
                CompareOp::Equal,
                writer_node_id.as_bytes().to_vec(),
            ),
        ];
        if let Some(replica) = replica {
            compares.push(Compare::create_revision(
                self.inner.keys.node(&replica.node_id),
                CompareOp::Greater,
                0,
            ));
            compares.push(Compare::value(
                self.inner.keys.node_started_at(&replica.node_id),
                CompareOp::Equal,
                replica.started_at.as_bytes().to_vec(),
            ));
        }
        let write = EtcdWrite {
            key: &key,
            value_bytes: data.len(),
            expected_bytes: 0,
        };
        let txn = Txn::new()
            .when(compares)
            .and_then(vec![TxnOp::put(key.clone(), data, None)]);
        let response = self.inner.guarded_txn(PUT_ALLOCATION, &write, txn).await?;
        Ok(response.succeeded())
    }

    /// Deletes the allocation table of `index_name`.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` after shutdown, and with `COORDINATOR_UNAVAILABLE` where etcd cannot be reached.
    pub async fn delete_allocation(&self, index_name: &str) -> ClusterResult<()> {
        self.inner.ensure_open()?;
        self.inner
            .delete("deleteAllocation", self.inner.keys.allocation(index_name))
            .await?;
        Ok(())
    }

    /// Returns the name of every index with a stored allocation table, in code point order.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` after shutdown, and with `COORDINATOR_UNAVAILABLE` where etcd cannot be reached.
    pub async fn list_allocations(&self) -> ClusterResult<Vec<String>> {
        self.inner.ensure_open()?;
        let prefix = self.inner.keys.allocation_prefix();
        let options = GetOptions::new().with_prefix().with_keys_only();
        let found = self
            .inner
            .get("listAllocations", prefix.as_bytes(), Some(options))
            .await?;
        let mut names: Vec<String> = found
            .kvs()
            .iter()
            .filter_map(|entry| {
                record_name(&String::from_utf8_lossy(entry.key()), &prefix).map(str::to_string)
            })
            .collect();
        names.sort();
        Ok(names)
    }

    /// Calls `handler` with every allocation table that etcd stores from now on, until the returned handle stops
    /// the watch.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` after shutdown or where 64 watches already run, and with
    /// `COORDINATOR_UNAVAILABLE` where etcd cannot be reached.
    pub async fn watch_allocation<F>(&self, handler: F) -> ClusterResult<WatchHandle>
    where
        F: Fn(AllocationTable) + Send + Sync + 'static,
    {
        let handler = Arc::new(handler);
        let prefix = self.inner.keys.allocation_prefix();
        let put_prefix = prefix.clone();
        let handlers = PrefixHandlers {
            put: Box::new(move |key, value| {
                if record_name(key, &put_prefix).is_some() {
                    handler(decode_allocation(value)?);
                }
                Ok(())
            }),
            delete: Box::new(|_| Ok(())),
        };
        watch_prefix(&self.inner, prefix, handlers).await
    }

    /// Returns the state of one partition, which is `Unassigned` where etcd stores none.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` where the stored state is unknown, and with `COORDINATOR_UNAVAILABLE` where etcd
    /// cannot be reached.
    pub async fn partition_state(
        &self,
        index_name: &str,
        partition_id: u64,
    ) -> ClusterResult<PartitionState> {
        self.inner.ensure_open()?;
        let key = self.inner.keys.partition(index_name, partition_id);
        let found = self.inner.get("getPartitionState", key, None).await?;
        match found.kvs().first() {
            None => Ok(PartitionState::Unassigned),
            Some(entry) => PartitionState::parse(&String::from_utf8_lossy(entry.value())),
        }
    }

    /// Stores the state of one partition.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` after shutdown, and with `COORDINATOR_UNAVAILABLE` where etcd cannot be reached.
    pub async fn put_partition_state(
        &self,
        index_name: &str,
        partition_id: u64,
        state: PartitionState,
    ) -> ClusterResult<()> {
        self.inner.ensure_open()?;
        let key = self.inner.keys.partition(index_name, partition_id);
        self.inner
            .put("putPartitionState", key, state.as_str())
            .await?;
        Ok(())
    }
}
