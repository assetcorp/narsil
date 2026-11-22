use std::sync::{Arc, Mutex};

use narsil::{Map, NarsilConfig};
use tokio::sync::watch;

use super::blocking::off_executor;
use super::config::DataNodeConfig;
use super::copies::LocalCopies;
use super::lost_copy::LostCopyWait;
use super::partition_stores::{partition_stores_answer, requested_index};
use super::reconcile::settle_local_indexes;
use super::watcher::{AllocationWatcher, WatcherSettings};
use crate::controller::lock;
use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::ClusterResult;
use crate::message::{TransportMessage, message_types, refusal};
use crate::node::{NodeErrorHandler, not_ready, report_failure};
use crate::transport::{BoxFuture, NodeTransport, Respond};

pub(crate) struct DataRole {
    node_id: String,
    coordinator: Arc<EtcdCoordinator>,
    engine: NarsilConfig,
    on_error: Option<NodeErrorHandler>,
    settled: Mutex<Option<Arc<LocalCopies>>>,
    watcher: tokio::sync::Mutex<Option<AllocationWatcher>>,
}

impl DataRole {
    pub(crate) fn new(
        node_id: String,
        coordinator: Arc<EtcdCoordinator>,
        config: DataNodeConfig,
        on_error: Option<NodeErrorHandler>,
    ) -> DataRole {
        DataRole {
            node_id,
            coordinator,
            engine: config.engine,
            on_error,
            settled: Mutex::new(None),
            watcher: tokio::sync::Mutex::new(None),
        }
    }

    pub(crate) async fn open(&self) -> ClusterResult<()> {
        let (node_id, engine) = (self.node_id.clone(), self.engine.clone());
        let copies = Arc::new(off_executor(move || LocalCopies::open(node_id, engine)).await??);
        let on_error = self.on_error.as_ref();
        match settle_local_indexes(&self.coordinator, &copies, &self.node_id, on_error).await {
            Ok(()) => {
                *lock(&self.settled) = Some(copies);
                Ok(())
            }
            Err(error) => {
                self.close_engine(copies).await;
                Err(error)
            }
        }
    }

    pub(crate) async fn wait_for_lost_copies(
        &self,
        stopping: &mut watch::Receiver<bool>,
        stand_for_election: &(dyn Fn() -> BoxFuture<'static, ()> + Sync),
    ) -> ClusterResult<()> {
        let copies = self.settled_copies()?;
        let wait = LostCopyWait {
            node_id: &self.node_id,
            coordinator: &self.coordinator,
            copies: &copies,
            on_error: self.on_error.as_ref(),
        };
        wait.wait(stopping, stand_for_election).await
    }

    pub(crate) async fn follow_allocations(
        &self,
        transport: Arc<dyn NodeTransport>,
    ) -> ClusterResult<()> {
        let copies = self.settled_copies()?;
        let started = AllocationWatcher::start(WatcherSettings {
            node_id: self.node_id.clone(),
            coordinator: Arc::clone(&self.coordinator),
            transport,
            copies,
            on_error: self.on_error.clone(),
        })
        .await?;
        if let Some(previous) = self.watcher.lock().await.replace(started) {
            previous.stop().await;
        }
        Ok(())
    }

    pub(crate) fn answers(message_type: &str) -> bool {
        message_type == message_types::CLUSTER_PARTITION_STORES
    }

    pub(crate) async fn answer(&self, message: TransportMessage, respond: Respond) {
        let reply = match self.answer_partition_stores(&message).await {
            Ok(reply) => reply,
            Err(error) => refusal(&message, &self.node_id, &error),
        };
        respond.send(reply).await;
    }

    async fn answer_partition_stores(
        &self,
        message: &TransportMessage,
    ) -> ClusterResult<TransportMessage> {
        let index_name = requested_index(message)?;
        let copies = self.settled_copies()?;
        let name = index_name.clone();
        let stored = off_executor(move || copies.stored_partitions(&name)).await??;
        partition_stores_answer(message, &self.node_id, &index_name, stored)
    }

    pub(crate) async fn close(&self) {
        if let Some(watcher) = self.watcher.lock().await.take() {
            watcher.stop().await;
        }
        let settled = lock(&self.settled).take();
        if let Some(copies) = settled {
            self.close_engine(copies).await;
        }
    }

    async fn close_engine(&self, copies: Arc<LocalCopies>) {
        let closed = off_executor(move || copies.close()).await;
        if let Err(error) = closed.and_then(|closed| closed) {
            report_failure(self.on_error.as_ref(), &error);
        }
    }

    fn settled_copies(&self) -> ClusterResult<Arc<LocalCopies>> {
        lock(&self.settled)
            .clone()
            .ok_or_else(|| not_ready(&self.node_id))
    }

    pub(crate) async fn document(
        &self,
        index_name: &str,
        document_id: &str,
    ) -> ClusterResult<Option<Map>> {
        let copies = self.settled_copies()?;
        let (index_name, document_id) = (index_name.to_string(), document_id.to_string());
        off_executor(move || copies.document(&index_name, &document_id)).await?
    }

    pub(crate) async fn drop_orphaned_copy(&self, index_name: &str) -> ClusterResult<()> {
        let copies = self.settled_copies()?;
        let index_name = index_name.to_string();
        off_executor(move || copies.drop_orphaned(&index_name)).await?
    }
}
