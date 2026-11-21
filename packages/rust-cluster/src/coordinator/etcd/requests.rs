use etcd_client::{DeleteResponse, GetOptions, GetResponse, PutResponse, Txn, TxnResponse};

use super::Inner;
use super::client::{EtcdWrite, call};
use crate::error::ClusterResult;

impl Inner {
    pub(crate) async fn get(
        &self,
        operation: &str,
        key: impl Into<Vec<u8>>,
        options: Option<GetOptions>,
    ) -> ClusterResult<GetResponse> {
        let key = key.into();
        call(&self.pool, operation, |mut clients| {
            let key = key.clone();
            let options = options.clone();
            async move { clients.kv.get(key, options).await }
        })
        .await
    }

    pub(crate) async fn put(
        &self,
        operation: &str,
        key: impl Into<Vec<u8>>,
        value: impl Into<Vec<u8>>,
    ) -> ClusterResult<PutResponse> {
        let key = key.into();
        let value = value.into();
        call(&self.pool, operation, |mut clients| {
            let key = key.clone();
            let value = value.clone();
            async move { clients.kv.put(key, value, None).await }
        })
        .await
    }

    pub(crate) async fn delete(
        &self,
        operation: &str,
        key: impl Into<Vec<u8>>,
    ) -> ClusterResult<DeleteResponse> {
        let key = key.into();
        call(&self.pool, operation, |mut clients| {
            let key = key.clone();
            async move { clients.kv.delete(key, None).await }
        })
        .await
    }

    pub(crate) async fn txn(&self, operation: &str, txn: Txn) -> ClusterResult<TxnResponse> {
        call(&self.pool, operation, |mut clients| {
            let txn = txn.clone();
            async move { clients.kv.txn(txn).await }
        })
        .await
    }

    pub(crate) async fn guarded_txn(
        &self,
        operation: &str,
        write: &EtcdWrite<'_>,
        txn: Txn,
    ) -> ClusterResult<TxnResponse> {
        self.guard
            .send(&self.pool, operation, write, |mut clients| {
                let txn = txn.clone();
                async move { clients.kv.txn(txn).await }
            })
            .await
    }

    pub(crate) async fn guarded_put(
        &self,
        operation: &str,
        write: &EtcdWrite<'_>,
        value: Vec<u8>,
    ) -> ClusterResult<PutResponse> {
        let key = write.key.to_string();
        self.guard
            .send(&self.pool, operation, write, |mut clients| {
                let key = key.clone();
                let value = value.clone();
                async move { clients.kv.put(key, value, None).await }
            })
            .await
    }
}
