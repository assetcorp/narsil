mod backup_restore;
mod catch_up;
mod commit;
mod condition;
mod copy_failure;
mod errors;
mod figures;
mod forward;
mod forward_answer;
mod forward_memory;
mod lead_handoff;
mod log;
mod log_order;
mod partition;
mod replica;
mod replicate;
mod reshard;
mod rollback;
mod run;
mod scope;
mod sync_apply;
mod sync_read;
mod term_start;
mod view;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{Semaphore, watch};

pub(crate) use self::backup_restore::StoredPartitionFiles;
use self::catch_up::{SnapshotSlots, catch_up_budget};
use self::copy_failure::CopyFailures;
pub(crate) use self::errors::abandoned_with_term;
pub(crate) use self::figures::LedPartitionFigures;
pub(crate) use self::forward::{fnv1a, fnv1a_uint32s, routed_partition, unassigned};
use self::partition::Partitions;
use self::reshard::ReshardState;
pub(crate) use self::sync_read::{SyncReadReply, SyncReadRequest};
pub(crate) use self::view::AllocationView;
use super::blocking::off_executor;
use super::copies::LocalCopies;
use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::ClusterResult;
use crate::memory::NodeMemory;
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
    reshard: ReshardState,
    catch_up_bytes: Semaphore,
    stopping: watch::Sender<bool>,
    shutting_down: watch::Sender<bool>,
    on_error: Option<NodeErrorHandler>,
    log_retention_bytes: u64,
    spool_directory: PathBuf,
    snapshot_slots: Mutex<SnapshotSlots>,
    memory: Option<Arc<NodeMemory>>,
}

pub(crate) struct PrimaryWritesSettings {
    pub(crate) node_id: String,
    pub(crate) coordinator: Arc<EtcdCoordinator>,
    pub(crate) transport: Arc<dyn NodeTransport>,
    pub(super) copies: Arc<LocalCopies>,
    pub(crate) view: Arc<AllocationView>,
    pub(crate) on_error: Option<NodeErrorHandler>,
    pub(crate) log_retention_bytes: u64,
    pub(crate) spool_directory: PathBuf,
    pub(crate) memory: Option<Arc<NodeMemory>>,
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
            reshard: ReshardState::default(),
            catch_up_bytes: catch_up_budget(),
            stopping: watch::Sender::new(false),
            shutting_down: watch::Sender::new(false),
            on_error: settings.on_error,
            log_retention_bytes: settings.log_retention_bytes,
            spool_directory: settings.spool_directory,
            snapshot_slots: Mutex::default(),
            memory: settings.memory,
        }
    }

    pub(crate) fn memory(&self) -> Option<Arc<NodeMemory>> {
        self.memory.clone()
    }

    pub(crate) fn spool_directory(&self) -> &Path {
        &self.spool_directory
    }

    pub(super) fn start(self: &Arc<Self>) {
        self.start_catch_up_pump();
    }

    pub(super) fn stop(&self) {
        self.stopping.send_replace(true);
        self.reshard.stop_every_job();
        self.catch_up_bytes.close();
        self.cancel_catch_up_feeds();
        self.view.stop();
    }

    pub(super) fn end_lead_holds(&self) {
        self.shutting_down.send_replace(true);
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

    pub(crate) fn view(&self) -> Arc<AllocationView> {
        Arc::clone(&self.view)
    }

    pub(crate) async fn stored_document(
        &self,
        index_name: &str,
        document_id: &str,
    ) -> ClusterResult<Option<narsil::Map>> {
        let (index_name, document_id) = (index_name.to_string(), document_id.to_string());
        self.on_copies(move |copies| copies.document(&index_name, &document_id))
            .await
    }

    pub(crate) fn refuse_orphaned(&self, index_name: &str) -> ClusterResult<()> {
        self.copies.refuse_orphaned(index_name)
    }

    pub(super) fn forget_index(&self, index_name: &str) {
        self.partitions.forget_index(index_name);
        self.failures.forget_index(index_name);
        self.reshard.forget_index(index_name);
    }

    pub(super) fn forget_partition(&self, index_name: &str, partition_id: u32) {
        self.partitions.forget_partition(index_name, partition_id);
        self.failures.forget_partition(index_name, partition_id);
        self.reshard.forget_partition(index_name, partition_id);
    }
}
