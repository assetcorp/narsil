use std::time::Duration;

use narsil::Value;

use super::constants::{
    BACKUP_JOB_CAS_ATTEMPTS, BACKUP_JOB_CAS_RETRY_MS, BACKUP_JOBS_KEY, MAX_FINISHED_BACKUP_JOBS,
};
use super::job_codec::{decode_jobs, encode_jobs};
use crate::controller::now_ms;
use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::{ClusterError, ClusterResult, codes};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BackupJobKind {
    Backup,
    Restore,
    Delete,
}

impl BackupJobKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            BackupJobKind::Backup => "backup",
            BackupJobKind::Restore => "restore",
            BackupJobKind::Delete => "delete",
        }
    }

    pub(super) fn parse(text: &str) -> Option<BackupJobKind> {
        match text {
            "backup" => Some(BackupJobKind::Backup),
            "restore" => Some(BackupJobKind::Restore),
            "delete" => Some(BackupJobKind::Delete),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BackupJobStatus {
    Running,
    Done,
    Failed,
}

impl BackupJobStatus {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            BackupJobStatus::Running => "running",
            BackupJobStatus::Done => "done",
            BackupJobStatus::Failed => "failed",
        }
    }

    pub(super) fn parse(text: &str) -> Option<BackupJobStatus> {
        match text {
            "running" => Some(BackupJobStatus::Running),
            "done" => Some(BackupJobStatus::Done),
            "failed" => Some(BackupJobStatus::Failed),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct BackupJobError {
    pub(crate) code: String,
    pub(crate) message: String,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct BackupJob {
    pub(crate) kind: BackupJobKind,
    pub(crate) backup_name: String,
    pub(crate) index_name: Option<String>,
    pub(crate) generation: Option<String>,
    pub(crate) name_index_uuid: Option<String>,
    pub(crate) status: BackupJobStatus,
    pub(crate) partitions_done: f64,
    pub(crate) partitions_total: f64,
    pub(crate) started_at: f64,
    pub(crate) finished_at: Option<f64>,
    pub(crate) error: Option<BackupJobError>,
}

impl BackupJob {
    pub(crate) fn running(
        kind: BackupJobKind,
        backup_name: &str,
        index_name: Option<&str>,
    ) -> BackupJob {
        BackupJob {
            kind,
            backup_name: backup_name.to_string(),
            index_name: index_name.map(str::to_string),
            generation: None,
            name_index_uuid: None,
            status: BackupJobStatus::Running,
            partitions_done: 0.0,
            partitions_total: 0.0,
            started_at: now_ms(),
            finished_at: None,
            error: None,
        }
    }

    pub(crate) fn is_running(&self) -> bool {
        self.status == BackupJobStatus::Running
    }
}

pub(crate) type BackupJobs = Vec<(String, BackupJob)>;

struct StoredJobs {
    jobs: BackupJobs,
    bytes: Option<Vec<u8>>,
}

async fn read_stored_jobs(coordinator: &EtcdCoordinator) -> ClusterResult<StoredJobs> {
    let bytes = coordinator.get(BACKUP_JOBS_KEY).await?;
    let Some(stored) = bytes.as_ref().filter(|bytes| !bytes.is_empty()) else {
        return Ok(StoredJobs {
            jobs: Vec::new(),
            bytes,
        });
    };
    let jobs = decode_jobs(stored)?;
    Ok(StoredJobs { jobs, bytes })
}

fn keep_newest_finished(jobs: &mut BackupJobs) {
    let mut finished: Vec<(String, f64)> = jobs
        .iter()
        .filter(|(_, job)| !job.is_running())
        .map(|(job_id, job)| (job_id.clone(), job.finished_at.unwrap_or(0.0)))
        .collect();
    if finished.len() <= MAX_FINISHED_BACKUP_JOBS {
        return;
    }
    finished.sort_by(|left, right| left.1.total_cmp(&right.1));
    let surplus = finished.len() - MAX_FINISHED_BACKUP_JOBS;
    let dropped: Vec<String> = finished
        .into_iter()
        .take(surplus)
        .map(|(job_id, _)| job_id)
        .collect();
    jobs.retain(|(job_id, _)| !dropped.contains(job_id));
}

pub(crate) async fn change_backup_jobs(
    coordinator: &EtcdCoordinator,
    mut change: impl FnMut(&mut BackupJobs) -> bool,
) -> ClusterResult<bool> {
    for _ in 0..BACKUP_JOB_CAS_ATTEMPTS {
        let StoredJobs { mut jobs, bytes } = read_stored_jobs(coordinator).await?;
        if !change(&mut jobs) {
            return Ok(false);
        }
        keep_newest_finished(&mut jobs);
        let encoded = encode_jobs(&jobs)?;
        if coordinator
            .compare_and_set(BACKUP_JOBS_KEY, bytes.as_deref(), &encoded)
            .await?
        {
            return Ok(true);
        }
        tokio::time::sleep(Duration::from_millis(BACKUP_JOB_CAS_RETRY_MS)).await;
    }
    Err(ClusterError::new(
        codes::ALLOCATION_FAILED,
        format!("The backup job record lost {BACKUP_JOB_CAS_ATTEMPTS} compare-and-set attempts"),
    )
    .with_detail("key", Value::from(BACKUP_JOBS_KEY)))
}

pub(crate) async fn read_backup_jobs(coordinator: &EtcdCoordinator) -> ClusterResult<BackupJobs> {
    Ok(read_stored_jobs(coordinator).await?.jobs)
}

fn conflict_of<'j>(jobs: &'j BackupJobs, job: &BackupJob) -> Option<&'j BackupJob> {
    jobs.iter().map(|(_, running)| running).find(|running| {
        if !running.is_running() {
            return false;
        }
        let same_backup = running.backup_name == job.backup_name;
        match job.kind {
            BackupJobKind::Backup => {
                running.kind == BackupJobKind::Delete
                    || (running.kind == BackupJobKind::Backup && same_backup)
            }
            BackupJobKind::Restore => running.kind == BackupJobKind::Delete && same_backup,
            BackupJobKind::Delete => running.kind != BackupJobKind::Restore || same_backup,
        }
    })
}

fn refusal(job: &BackupJob, conflicting: &BackupJob) -> ClusterError {
    if job.kind == BackupJobKind::Backup && conflicting.kind == BackupJobKind::Backup {
        return ClusterError::new(
            codes::BACKUP_ALREADY_EXISTS,
            format!("A backup named '{}' is already running", job.backup_name),
        )
        .with_detail("backupName", Value::from(job.backup_name.as_str()));
    }
    ClusterError::new(
        codes::BACKUP_IN_PROGRESS,
        format!(
            "A {} of backup '{}' is running, so the {} of '{}' can start once it ends",
            conflicting.kind.as_str(),
            conflicting.backup_name,
            job.kind.as_str(),
            job.backup_name
        ),
    )
    .with_detail("backupName", Value::from(job.backup_name.as_str()))
    .with_detail("running", Value::from(conflicting.kind.as_str()))
    .with_detail(
        "runningBackup",
        Value::from(conflicting.backup_name.as_str()),
    )
}

pub(crate) async fn start_backup_job(
    coordinator: &EtcdCoordinator,
    job_id: &str,
    job: &BackupJob,
) -> ClusterResult<()> {
    let mut conflicting = None;
    change_backup_jobs(coordinator, |jobs| {
        conflicting = conflict_of(jobs, job).cloned();
        if conflicting.is_some() {
            return false;
        }
        jobs.push((job_id.to_string(), job.clone()));
        true
    })
    .await?;
    match conflicting {
        Some(conflicting) => Err(refusal(job, &conflicting)),
        None => Ok(()),
    }
}

pub(crate) async fn update_backup_job(
    coordinator: &EtcdCoordinator,
    job_id: &str,
    change: impl Fn(&BackupJob) -> BackupJob,
) -> ClusterResult<bool> {
    change_backup_jobs(coordinator, |jobs| {
        let Some((_, current)) = jobs.iter_mut().find(|(id, _)| id == job_id) else {
            return false;
        };
        if !current.is_running() {
            return false;
        }
        *current = change(current);
        true
    })
    .await
}

pub(crate) fn backup_failure_of(error: &ClusterError) -> BackupJobError {
    BackupJobError {
        code: error.code().to_string(),
        message: error.message().to_string(),
    }
}

pub(crate) fn finished_job(job: &BackupJob, error: Option<&ClusterError>) -> BackupJob {
    BackupJob {
        status: match error {
            None => BackupJobStatus::Done,
            Some(_) => BackupJobStatus::Failed,
        },
        finished_at: Some(now_ms()),
        error: error.map(backup_failure_of),
        ..job.clone()
    }
}

pub(crate) async fn finish_backup_job(
    coordinator: &EtcdCoordinator,
    job_id: &str,
    error: Option<&ClusterError>,
) -> ClusterResult<()> {
    update_backup_job(coordinator, job_id, |job| finished_job(job, error)).await?;
    Ok(())
}
