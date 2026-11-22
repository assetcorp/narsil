use std::sync::{Arc, Mutex};

use narsil::{Map, NarsilConfig};

use super::blocking::off_executor;
use super::config::DataNodeConfig;
use super::copies::LocalCopies;
use super::reconcile::settle_local_indexes;
use crate::controller::lock;
use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::ClusterResult;
use crate::node::{NodeErrorHandler, not_ready, report_failure};

pub(crate) struct DataRole {
    node_id: String,
    coordinator: Arc<EtcdCoordinator>,
    engine: NarsilConfig,
    on_error: Option<NodeErrorHandler>,
    settled: Mutex<Option<Arc<LocalCopies>>>,
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

    pub(crate) async fn close(&self) {
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
