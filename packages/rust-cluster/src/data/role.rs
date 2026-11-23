use std::sync::{Arc, Mutex};

use narsil::Map;
use tokio::sync::watch;

use super::blocking::off_executor;
use super::config::DataNodeConfig;
use super::copies::LocalCopies;
use super::lost_copy::LostCopyWait;
use super::partition_stores::{partition_stores_answer, requested_index};
use super::queries::{QueryDeps, answer_query, answers_query};
use super::reconcile::settle_local_indexes;
use super::watcher::{AllocationWatcher, WatcherSettings};
use super::writes::{AllocationView, PrimaryWrites, PrimaryWritesSettings};
use crate::controller::lock;
use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::ClusterResult;
use crate::message::{TransportMessage, message_types, refusal};
use crate::node::{NodeErrorHandler, not_ready, report_failure};
use crate::transport::{BoxFuture, NodeTransport, Respond};

pub(crate) struct DataRole {
    node_id: String,
    coordinator: Arc<EtcdCoordinator>,
    config: DataNodeConfig,
    on_error: Option<NodeErrorHandler>,
    settled: Mutex<Option<Arc<LocalCopies>>>,
    watcher: tokio::sync::Mutex<Option<AllocationWatcher>>,
    writes: Mutex<Option<Arc<PrimaryWrites>>>,
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
            config,
            on_error,
            settled: Mutex::new(None),
            watcher: tokio::sync::Mutex::new(None),
            writes: Mutex::new(None),
        }
    }

    pub(crate) async fn open(&self) -> ClusterResult<()> {
        let (node_id, config) = (self.node_id.clone(), self.config.clone());
        let copies = Arc::new(off_executor(move || LocalCopies::open(node_id, config)).await??);
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
        let view = Arc::new(AllocationView::new(Arc::clone(&self.coordinator)));
        if let Err(error) = view.start().await {
            view.stop();
            return Err(error);
        }
        let writes = Arc::new(PrimaryWrites::new(PrimaryWritesSettings {
            node_id: self.node_id.clone(),
            coordinator: Arc::clone(&self.coordinator),
            transport: Arc::clone(&transport),
            copies: Arc::clone(&copies),
            view: Arc::clone(&view),
            on_error: self.on_error.clone(),
            log_retention_bytes: self.config.log_retention_bytes,
            spool_directory: self
                .config
                .snapshot_spool_directory
                .clone()
                .unwrap_or_else(std::env::temp_dir),
        }));
        let started = AllocationWatcher::start(WatcherSettings {
            node_id: self.node_id.clone(),
            coordinator: Arc::clone(&self.coordinator),
            transport,
            copies,
            view,
            writes: Arc::clone(&writes),
            on_error: self.on_error.clone(),
        })
        .await;
        let started = match started {
            Ok(started) => started,
            Err(error) => {
                writes.stop();
                return Err(error);
            }
        };
        writes.start();
        if let Some(previous) = lock(&self.writes).replace(writes) {
            previous.stop();
        }
        if let Some(previous) = self.watcher.lock().await.replace(started) {
            previous.stop().await;
        }
        Ok(())
    }

    pub(crate) fn answers(message_type: &str) -> bool {
        matches!(
            message_type,
            message_types::CLUSTER_PARTITION_STORES
                | message_types::REPLICATION_FORWARD
                | message_types::REPLICATION_FORWARD_BATCH
                | message_types::REPLICATION_ENTRY
                | message_types::REPLICATION_ENTRY_BATCH
                | message_types::REPLICATION_TERM_START
                | message_types::REPLICATION_SYNC_REQUEST
        ) || answers_query(message_type)
    }

    async fn answer_query_message(&self, message: &TransportMessage) -> TransportMessage {
        let deps = match (self.settled_copies(), self.primary_writes()) {
            (Ok(copies), Ok(writes)) => QueryDeps {
                node_id: &self.node_id,
                copies,
                view: writes.view(),
            },
            (Err(error), _) | (_, Err(error)) => {
                return refusal(message, &self.node_id, &error);
            }
        };
        match answer_query(&deps, message).await {
            Ok(reply) => reply,
            Err(error) => refusal(message, &self.node_id, &error),
        }
    }

    pub(crate) async fn answer(&self, message: TransportMessage, respond: Respond) {
        if message.message_type == message_types::REPLICATION_SYNC_REQUEST {
            return match self.primary_writes() {
                Ok(writes) => writes.answer_sync_request(&message, &respond).await,
                Err(error) => respond.send(refusal(&message, &self.node_id, &error)).await,
            };
        }
        if answers_query(&message.message_type) {
            let reply = self.answer_query_message(&message).await;
            return respond.send(reply).await;
        }
        let reply = match message.message_type.as_str() {
            message_types::REPLICATION_FORWARD => match self.primary_writes() {
                Ok(writes) => writes.answer_forward(&message).await,
                Err(error) => refusal(&message, &self.node_id, &error),
            },
            message_types::REPLICATION_FORWARD_BATCH => match self.primary_writes() {
                Ok(writes) => writes.answer_forward_batch(&message).await,
                Err(error) => refusal(&message, &self.node_id, &error),
            },
            message_types::REPLICATION_ENTRY | message_types::REPLICATION_ENTRY_BATCH => {
                match self.primary_writes() {
                    Ok(writes) => writes.answer_entries(&message).await,
                    Err(error) => refusal(&message, &self.node_id, &error),
                }
            }
            message_types::REPLICATION_TERM_START => match self.primary_writes() {
                Ok(writes) => writes.answer_term_start(&message).await,
                Err(error) => refusal(&message, &self.node_id, &error),
            },
            _ => match self.answer_partition_stores(&message).await {
                Ok(reply) => reply,
                Err(error) => refusal(&message, &self.node_id, &error),
            },
        };
        respond.send(reply).await;
    }

    pub(crate) async fn unserved_partition_count(&self) -> usize {
        self.watcher
            .lock()
            .await
            .as_ref()
            .map_or(0, AllocationWatcher::unserved_partition_count)
    }

    pub(crate) fn primary_writes(&self) -> ClusterResult<Arc<PrimaryWrites>> {
        lock(&self.writes)
            .clone()
            .ok_or_else(|| not_ready(&self.node_id))
    }

    async fn answer_partition_stores(
        &self,
        message: &TransportMessage,
    ) -> ClusterResult<TransportMessage> {
        let index_name = requested_index(message)?;
        let copies = self.settled_copies()?;
        let name = index_name.clone();
        let mut stored = off_executor(move || copies.stored_partitions(&name)).await??;
        if let Some(writes) = lock(&self.writes).clone() {
            stored
                .partition_ids
                .retain(|partition_id| !writes.copy_unlisted(&index_name, *partition_id));
        }
        partition_stores_answer(message, &self.node_id, &index_name, stored)
    }

    pub(crate) async fn close(&self) {
        if let Some(writes) = lock(&self.writes).take() {
            writes.stop();
        }
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
        let name = index_name.to_string();
        off_executor(move || copies.drop_orphaned(&name)).await??;
        if let Some(writes) = lock(&self.writes).clone() {
            writes.forget_index(index_name);
        }
        Ok(())
    }
}
