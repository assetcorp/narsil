use std::sync::Arc;

use etcd_client::{Compare, CompareOp, GetOptions, Txn, TxnOp};
use narsil::Value;

use super::EtcdCoordinator;
use super::client::EtcdWrite;
use super::keys::{index_metadata_prefix, index_name_of_metadata_suffix, suffix_after};
use super::watch::{PrefixHandlers, WatchHandle, watch_prefix};
use crate::coordinator::serialization::{decode_schema, encode_schema};
use crate::coordinator::types::{IndexMetadataEvent, SchemaEvent};
use crate::error::ClusterResult;

impl EtcdCoordinator {
    /// Returns the bytes stored under `key`, or `None` where etcd holds none.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` after shutdown, and with `COORDINATOR_UNAVAILABLE` where etcd cannot be reached.
    pub async fn get(&self, key: &str) -> ClusterResult<Option<Vec<u8>>> {
        self.inner.ensure_open()?;
        let found = self
            .inner
            .get("get", self.inner.keys.generic(key), None)
            .await?;
        Ok(found.kvs().first().map(|entry| entry.value().to_vec()))
    }

    /// Writes `value` under `key` only while `key` holds `expected`, or while it holds nothing where `expected` is
    /// `None`, and returns whether etcd took the write.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` where the request would pass `max_request_bytes`, and with
    /// `COORDINATOR_UNAVAILABLE` where etcd cannot be reached.
    pub async fn compare_and_set(
        &self,
        key: &str,
        expected: Option<&[u8]>,
        value: &[u8],
    ) -> ClusterResult<bool> {
        self.inner.ensure_open()?;
        let etcd_key = self.inner.keys.generic(key);
        let conditions = match expected {
            None => vec![Compare::create_revision(
                etcd_key.clone(),
                CompareOp::Equal,
                0,
            )],
            Some(expected) => vec![
                Compare::create_revision(etcd_key.clone(), CompareOp::Greater, 0),
                Compare::value(etcd_key.clone(), CompareOp::Equal, expected.to_vec()),
            ],
        };
        let txn = Txn::new().when(conditions).and_then(vec![TxnOp::put(
            etcd_key.clone(),
            value.to_vec(),
            None,
        )]);
        let write = EtcdWrite {
            key: &etcd_key,
            value_bytes: value.len(),
            expected_bytes: expected.map_or(0, <[u8]>::len),
        };
        let response = self.inner.guarded_txn("compareAndSet", &write, txn).await?;
        Ok(response.succeeded())
    }

    /// Deletes `key`.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` after shutdown, and with `COORDINATOR_UNAVAILABLE` where etcd cannot be reached.
    pub async fn delete(&self, key: &str) -> ClusterResult<()> {
        self.inner.ensure_open()?;
        self.inner
            .delete("delete", self.inner.keys.generic(key))
            .await?;
        Ok(())
    }

    /// Returns the schema stored for `index_name`, or `None` where etcd holds none.
    ///
    /// # Errors
    ///
    /// Fails where the stored schema is not MessagePack, and with `COORDINATOR_UNAVAILABLE` where etcd cannot be
    /// reached.
    pub async fn schema(&self, index_name: &str) -> ClusterResult<Option<Value>> {
        self.inner.ensure_open()?;
        let found = self
            .inner
            .get("getSchema", self.inner.keys.schema(index_name), None)
            .await?;
        found
            .kvs()
            .first()
            .map(|entry| decode_schema(entry.value()))
            .transpose()
    }

    /// Stores `schema` for `index_name`.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` where the request would pass `max_request_bytes`, and with
    /// `COORDINATOR_UNAVAILABLE` where etcd cannot be reached.
    pub async fn put_schema(&self, index_name: &str, schema: &Value) -> ClusterResult<()> {
        self.inner.ensure_open()?;
        let key = self.inner.keys.schema(index_name);
        let value = encode_schema(schema)?;
        let write = EtcdWrite {
            key: &key,
            value_bytes: value.len(),
            expected_bytes: 0,
        };
        self.inner.guarded_put("putSchema", &write, value).await?;
        Ok(())
    }

    /// Deletes the schema of `index_name`.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` after shutdown, and with `COORDINATOR_UNAVAILABLE` where etcd cannot be reached.
    pub async fn drop_schema(&self, index_name: &str) -> ClusterResult<()> {
        self.inner.ensure_open()?;
        self.inner
            .delete("dropSchema", self.inner.keys.schema(index_name))
            .await?;
        Ok(())
    }

    /// Returns the name of every index with a stored schema, in code point order.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` after shutdown, and with `COORDINATOR_UNAVAILABLE` where etcd cannot be reached.
    pub async fn list_schemas(&self) -> ClusterResult<Vec<String>> {
        self.inner.ensure_open()?;
        let prefix = self.inner.keys.schema_prefix();
        let options = GetOptions::new().with_prefix().with_keys_only();
        let found = self
            .inner
            .get("listSchemas", prefix.as_bytes(), Some(options))
            .await?;
        let mut names: Vec<String> = found
            .kvs()
            .iter()
            .map(|entry| suffix_after(&String::from_utf8_lossy(entry.key()), &prefix).to_string())
            .collect();
        names.sort();
        Ok(names)
    }

    /// Calls `handler` with every schema that is written or dropped from now on, until the returned handle stops
    /// the watch.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` after shutdown or where 64 watches already run, and with
    /// `COORDINATOR_UNAVAILABLE` where etcd cannot be reached.
    pub async fn watch_schemas<F>(&self, handler: F) -> ClusterResult<WatchHandle>
    where
        F: Fn(SchemaEvent) + Send + Sync + 'static,
    {
        let prefix = self.inner.keys.schema_prefix();
        let handler = Arc::new(handler);
        let on_put = Arc::clone(&handler);
        let put_prefix = prefix.clone();
        let delete_prefix = prefix.clone();
        let handlers = PrefixHandlers {
            put: Box::new(move |key, value| {
                on_put(SchemaEvent::Created {
                    index_name: suffix_after(key, &put_prefix).to_string(),
                    schema: decode_schema(value)?,
                });
                Ok(())
            }),
            delete: Box::new(move |key| {
                handler(SchemaEvent::Dropped {
                    index_name: suffix_after(key, &delete_prefix).to_string(),
                });
                Ok(())
            }),
        };
        watch_prefix(&self.inner, prefix, handlers).await
    }

    /// Calls `handler` with every change to the stored configuration of an index from now on, until the returned
    /// handle stops the watch.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` after shutdown or where 64 watches already run, and with
    /// `COORDINATOR_UNAVAILABLE` where etcd cannot be reached.
    pub async fn watch_index_metadata<F>(&self, handler: F) -> ClusterResult<WatchHandle>
    where
        F: Fn(IndexMetadataEvent) + Send + Sync + 'static,
    {
        let prefix = index_metadata_prefix(&self.inner.keys);
        let handler = Arc::new(handler);
        let on_put = Arc::clone(&handler);
        let put_prefix = prefix.clone();
        let delete_prefix = prefix.clone();
        let handlers = PrefixHandlers {
            put: Box::new(move |key, value| {
                if let Some(index_name) = key
                    .get(put_prefix.len()..)
                    .and_then(index_name_of_metadata_suffix)
                {
                    on_put(IndexMetadataEvent {
                        index_name: index_name.to_string(),
                        metadata: (!value.is_empty()).then(|| value.to_vec()),
                    });
                }
                Ok(())
            }),
            delete: Box::new(move |key| {
                if let Some(index_name) = key
                    .get(delete_prefix.len()..)
                    .and_then(index_name_of_metadata_suffix)
                {
                    handler(IndexMetadataEvent {
                        index_name: index_name.to_string(),
                        metadata: None,
                    });
                }
                Ok(())
            }),
        };
        watch_prefix(&self.inner, prefix, handlers).await
    }
}
