mod commit;
mod condition;
mod copy_failure;
mod errors;
mod forward;
mod log;
mod partition;
mod replicate;
mod rollback;
mod run;
mod scope;
mod term_start;
mod view;

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;

use self::copy_failure::CopyFailures;
use self::partition::Partitions;
pub(crate) use self::view::AllocationView;
use super::blocking::off_executor;
use super::copies::LocalCopies;
use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::ClusterResult;
use crate::message::TransportMessage;
use crate::node::{NodeErrorHandler, generate_node_id, report_failure};
use crate::transport::NodeTransport;

pub(crate) struct PrimaryWrites {
    node_id: String,
    coordinator: Arc<EtcdCoordinator>,
    transport: Arc<dyn NodeTransport>,
    copies: Arc<LocalCopies>,
    view: Arc<AllocationView>,
    partitions: Partitions,
    failures: CopyFailures,
    stopping: watch::Sender<bool>,
    on_error: Option<NodeErrorHandler>,
}

pub(crate) struct PrimaryWritesSettings {
    pub(crate) node_id: String,
    pub(crate) coordinator: Arc<EtcdCoordinator>,
    pub(crate) transport: Arc<dyn NodeTransport>,
    pub(super) copies: Arc<LocalCopies>,
    pub(crate) view: Arc<AllocationView>,
    pub(crate) on_error: Option<NodeErrorHandler>,
}

impl PrimaryWrites {
    pub(super) fn new(settings: PrimaryWritesSettings) -> PrimaryWrites {
        PrimaryWrites {
            node_id: settings.node_id,
            coordinator: settings.coordinator,
            transport: settings.transport,
            copies: settings.copies,
            view: settings.view,
            partitions: Partitions::default(),
            failures: CopyFailures::default(),
            stopping: watch::Sender::new(false),
            on_error: settings.on_error,
        }
    }

    pub(super) fn stop(&self) {
        self.stopping.send_replace(true);
        self.view.stop();
    }

    fn is_stopping(&self) -> bool {
        *self.stopping.borrow()
    }

    fn report(&self, error: &crate::error::ClusterError) {
        if !self.is_stopping() {
            report_failure(self.on_error.as_ref(), error);
        }
    }

    fn replication_timeout(&self) -> Duration {
        self.transport.timeouts().replication_timeout
    }

    fn message(&self, message_type: &str, payload: Vec<u8>) -> ClusterResult<TransportMessage> {
        Ok(TransportMessage::new(
            message_type,
            self.node_id.as_str(),
            generate_node_id()?,
            payload,
        ))
    }

    async fn on_copies<T, F>(&self, work: F) -> ClusterResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&LocalCopies) -> ClusterResult<T> + Send + 'static,
    {
        let copies = Arc::clone(&self.copies);
        off_executor(move || work(&copies)).await?
    }

    pub(super) fn forget_index(&self, index_name: &str) {
        self.partitions.forget_index(index_name);
    }

    pub(super) fn forget_partition(&self, index_name: &str, partition_id: u32) {
        self.partitions.forget_partition(index_name, partition_id);
    }
}
