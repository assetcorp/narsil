use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use narsil::Value;

use super::jobs::{BackupJob, update_backup_job};
use super::store::BackupStore;
use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::transport::NodeTransport;

pub(crate) type ActiveCheck = Arc<dyn Fn() -> bool + Send + Sync>;
pub(crate) type BackupErrorHandler = Arc<dyn Fn(&ClusterError) + Send + Sync>;

pub(crate) struct BackupControllerDeps {
    pub(crate) node_id: String,
    pub(crate) coordinator: Arc<EtcdCoordinator>,
    pub(crate) transport: Arc<dyn NodeTransport>,
    pub(crate) is_active: ActiveCheck,
    pub(crate) on_error: BackupErrorHandler,
    pub(crate) store: Option<BackupStore>,
    pub(crate) driving: Mutex<HashSet<String>>,
}

#[derive(Clone)]
pub(crate) struct BackupDriverContext {
    pub(crate) deps: Arc<BackupControllerDeps>,
    pub(crate) store: BackupStore,
    pub(crate) job_id: String,
    pub(crate) job: BackupJob,
}

impl BackupDriverContext {
    pub(crate) fn coordinator(&self) -> &EtcdCoordinator {
        &self.deps.coordinator
    }

    pub(crate) fn node_id(&self) -> &str {
        &self.deps.node_id
    }

    pub(crate) fn report(&self, error: &ClusterError) {
        (self.deps.on_error)(error);
    }

    pub(crate) fn stopped_driving(&self) -> ClusterError {
        ClusterError::new(
            codes::NODE_NOT_CONTROLLER,
            format!(
                "Node '{}' stopped driving the {} of backup '{}', because it lost the controller lease or the job ended elsewhere",
                self.node_id(),
                self.job.kind.as_str(),
                self.job.backup_name
            ),
        )
        .with_detail("backupName", Value::from(self.job.backup_name.as_str()))
        .with_detail("nodeId", Value::from(self.node_id()))
        .with_detail("jobId", Value::from(self.job_id.as_str()))
    }

    pub(crate) fn assert_still_driving(&self) -> ClusterResult<()> {
        if (self.deps.is_active)() {
            return Ok(());
        }
        Err(self.stopped_driving())
    }

    pub(crate) fn job_index_name(&self) -> ClusterResult<String> {
        self.job.index_name.clone().ok_or_else(|| {
            ClusterError::new(
                codes::CONTROLLER_METADATA_INVALID,
                format!(
                    "The {} job of backup '{}' records no index name",
                    self.job.kind.as_str(),
                    self.job.backup_name
                ),
            )
            .with_detail("backupName", Value::from(self.job.backup_name.as_str()))
            .with_detail("jobId", Value::from(self.job_id.as_str()))
        })
    }

    pub(crate) async fn record_job_change(
        &self,
        change: impl Fn(&BackupJob) -> BackupJob,
    ) -> ClusterResult<()> {
        self.assert_still_driving()?;
        if !update_backup_job(self.coordinator(), &self.job_id, change).await? {
            return Err(self.stopped_driving());
        }
        Ok(())
    }

    pub(crate) async fn report_job_progress(&self, done: u64, total: u64) -> ClusterResult<()> {
        self.record_job_change(|job| BackupJob {
            partitions_done: done as f64,
            partitions_total: total as f64,
            ..job.clone()
        })
        .await
    }
}
