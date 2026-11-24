mod attempt;
mod batch;
mod remote;
mod retry;
mod rules;
mod sent_fields;
mod settle;
mod wait;
mod write;

use std::sync::{Arc, Mutex};

use narsil::Value;
use tokio::sync::watch;

pub(crate) use self::write::ClientWrite;
use crate::allocator::Table;
use crate::constants::HIDDEN_GENERATION_PREFIX;
use crate::controller::{lock, stored_index_metadata};
use crate::coordinator::etcd::{EtcdCoordinator, WatchHandle};
use crate::data::{AllocationView, PrimaryWrites};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::memory::{AdmittedWrite, NodeMemory, require_writable_index};
use crate::payload::forward::ForwardKind;
use crate::transport::NodeTransport;

pub(crate) struct WriteRouter {
    node_id: String,
    coordinator: Arc<EtcdCoordinator>,
    transport: Arc<dyn NodeTransport>,
    view: Arc<AllocationView>,
    local: Option<Arc<PrimaryWrites>>,
    memory: Option<Arc<NodeMemory>>,
    watch: Mutex<Option<WatchHandle>>,
    stopping: watch::Sender<bool>,
}

fn hidden_generation(index_name: &str) -> ClusterError {
    ClusterError::new(
        codes::CONFIG_INVALID,
        format!(
            "Index names that start with '{HIDDEN_GENERATION_PREFIX}' are reserved for partition count changes"
        ),
    )
    .with_detail("indexName", Value::from(index_name))
}

impl WriteRouter {
    pub(crate) async fn start(
        node_id: String,
        coordinator: Arc<EtcdCoordinator>,
        transport: Arc<dyn NodeTransport>,
        local: Option<Arc<PrimaryWrites>>,
        memory: Option<Arc<NodeMemory>>,
    ) -> ClusterResult<Arc<WriteRouter>> {
        let (view, watch) = match &local {
            Some(writes) => (writes.view(), None),
            None => {
                let view = Arc::new(AllocationView::new(Arc::clone(&coordinator)));
                if let Err(error) = view.start().await {
                    view.stop();
                    return Err(error);
                }
                let observed = Arc::clone(&view);
                let watched = coordinator
                    .watch_allocation(move |stored| {
                        observed.observe(&Table::from_stored(&stored));
                    })
                    .await;
                match watched {
                    Ok(handle) => (view, Some(handle)),
                    Err(error) => {
                        view.stop();
                        return Err(error);
                    }
                }
            }
        };
        Ok(Arc::new(WriteRouter {
            node_id,
            coordinator,
            transport,
            view,
            local,
            memory,
            watch: Mutex::new(watch),
            stopping: watch::Sender::new(false),
        }))
    }

    pub(crate) fn stop_waiting(&self) {
        self.stopping.send_replace(true);
    }

    pub(crate) fn stop(&self) {
        self.stop_waiting();
        if let Some(handle) = lock(&self.watch).take() {
            handle.stop();
            self.view.stop();
        }
    }

    pub(crate) fn view(&self) -> Arc<AllocationView> {
        Arc::clone(&self.view)
    }

    fn is_stopping(&self) -> bool {
        *self.stopping.borrow()
    }

    fn require_writable(&self, table: &Table) -> ClusterResult<()> {
        require_writable_index(table, self.memory.as_deref().map(|memory| &memory.view))
    }

    fn admit(
        &self,
        index_name: &str,
        writes: &[ClientWrite],
    ) -> ClusterResult<Option<AdmittedWrite>> {
        let Some(memory) = &self.memory else {
            return Ok(None);
        };
        if writes.iter().all(|write| write.kind == ForwardKind::Remove) {
            return Ok(None);
        }
        memory.before_admit();
        let bytes = writes.iter().fold(0u64, |total, write| {
            total.saturating_add(write.estimated_bytes)
        });
        memory.pressure.admit(index_name, bytes).map(Some)
    }

    async fn serving_name(&self, index_name: &str) -> ClusterResult<String> {
        if index_name.starts_with(HIDDEN_GENERATION_PREFIX) {
            return Err(hidden_generation(index_name));
        }
        let table = self.view.read(index_name).await?;
        Ok(table
            .and_then(|table| table.generation)
            .unwrap_or_else(|| index_name.to_string()))
    }

    async fn routable_table(&self, serving_name: &str) -> ClusterResult<Table> {
        if let Some(local) = &self.local {
            local.refuse_orphaned(serving_name)?;
        }
        if let Some(table) = self.view.read(serving_name).await?
            && !table.assignments.is_empty()
        {
            return Ok(table);
        }
        if stored_index_metadata(&self.coordinator, serving_name)
            .await?
            .is_none()
        {
            return Err(ClusterError::new(
                codes::INDEX_NOT_FOUND,
                format!("Index \"{serving_name}\" does not exist"),
            )
            .with_detail("indexName", Value::from(serving_name)));
        }
        Err(ClusterError::new(
            codes::QUERY_ROUTING_FAILED,
            format!(
                "The cluster owns index '{serving_name}' and holds no allocation table for it yet, so this node cannot place a write"
            ),
        )
        .with_detail("indexName", Value::from(serving_name)))
    }
}
