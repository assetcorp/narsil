use std::sync::Arc;

use super::{NodeInner, node_error};
use crate::controller::lock;
use crate::error::{ClusterResult, codes};
use crate::reads::{ReadDeps, ReadSettings};
use crate::routing::WriteRouter;

impl NodeInner {
    pub(in crate::node) fn router(&self) -> ClusterResult<Arc<WriteRouter>> {
        lock(&self.router).clone().ok_or_else(|| {
            let node_id = self.node_id();
            node_error(
                codes::NODE_NOT_JOINED,
                format!("Node '{node_id}' has not joined the cluster, so it routes no write"),
                node_id,
            )
        })
    }

    pub(super) async fn start_routing(&self) -> ClusterResult<()> {
        let local = match &self.data {
            Some(data) => Some(data.primary_writes()?),
            None => None,
        };
        let local_reads = match &self.data {
            Some(data) => Some(data.local_reads()?),
            None => None,
        };
        let router = WriteRouter::start(
            self.node_id().to_string(),
            Arc::clone(&self.coordinator),
            Arc::clone(&self.transport),
            local,
            self.memory(),
        )
        .await?;
        let reads = ReadDeps::start(ReadSettings {
            node_id: self.node_id().to_string(),
            coordinator: Arc::clone(&self.coordinator),
            transport: Arc::clone(&self.transport),
            view: router.view(),
            local: local_reads,
            query: self.query,
            on_error: self.on_error.clone(),
        })
        .await;
        let reads = match reads {
            Ok(reads) => reads,
            Err(error) => {
                router.stop();
                return Err(error);
            }
        };
        if let Some(previous) = lock(&self.router).replace(router) {
            previous.stop();
        }
        if let Some(previous) = lock(&self.reads).replace(reads) {
            previous.stop();
        }
        Ok(())
    }

    pub(in crate::node) fn reads(&self) -> ClusterResult<Arc<ReadDeps>> {
        lock(&self.reads).clone().ok_or_else(|| {
            let node_id = self.node_id();
            node_error(
                codes::NODE_NOT_JOINED,
                format!("Node '{node_id}' has not joined the cluster, so it routes no read"),
                node_id,
            )
        })
    }
}
