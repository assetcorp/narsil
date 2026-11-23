use std::time::Duration;

use narsil::Value;

use super::constants::BACKUP_JOB_POLL_INTERVAL_MS;
use super::jobs::{BackupJob, BackupJobStatus, read_backup_jobs};
use super::types::{BackupProgress, BackupProgressHandler};
use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::{ClusterError, ClusterResult, codes};

pub(crate) struct BackupJobWait<'w> {
    pub(crate) coordinator: &'w EtcdCoordinator,
    pub(crate) job_id: &'w str,
    pub(crate) guard: &'w (dyn Fn() -> ClusterResult<()> + Sync),
    pub(crate) on_progress: Option<&'w BackupProgressHandler>,
}

fn vanished(job_id: &str) -> ClusterError {
    ClusterError::new(
        codes::ALLOCATION_FAILED,
        format!("The record of backup job '{job_id}' disappeared before the job ended, so its outcome is unknown"),
    )
    .with_detail("jobId", Value::from(job_id))
}

fn failed(job: &BackupJob, job_id: &str) -> ClusterError {
    let (code, message) = match &job.error {
        Some(error) => (error.code.clone(), error.message.clone()),
        None => (
            codes::ALLOCATION_FAILED.to_string(),
            format!("The {} job failed", job.kind.as_str()),
        ),
    };
    let error = ClusterError::new(code, message)
        .with_detail("backupName", Value::from(job.backup_name.as_str()))
        .with_detail("jobId", Value::from(job_id));
    match &job.index_name {
        Some(index_name) => error.with_detail("indexName", Value::from(index_name.as_str())),
        None => error,
    }
}

pub(crate) async fn await_backup_job(wait: BackupJobWait<'_>) -> ClusterResult<BackupJob> {
    let mut reported = None;
    loop {
        (wait.guard)()?;
        let job = read_backup_jobs(wait.coordinator)
            .await?
            .into_iter()
            .find(|(job_id, _)| job_id == wait.job_id)
            .map(|(_, job)| job)
            .ok_or_else(|| vanished(wait.job_id))?;
        let progress = BackupProgress {
            done: job.partitions_done as u64,
            total: job.partitions_total as u64,
        };
        if reported != Some(progress) {
            reported = Some(progress);
            if let Some(on_progress) = wait.on_progress {
                on_progress(progress);
            }
        }
        match job.status {
            BackupJobStatus::Done => return Ok(job),
            BackupJobStatus::Failed => return Err(failed(&job, wait.job_id)),
            BackupJobStatus::Running => {}
        }
        tokio::time::sleep(Duration::from_millis(BACKUP_JOB_POLL_INTERVAL_MS)).await;
    }
}
