use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use narsil::Value;
use tokio::task::JoinHandle;

use super::constants::BACKUP_SWEEP_INTERVAL_MS;
use super::controller_messages::{
    BackupRun, answer_backup_request, deletion_run, drive_backup_job,
};
use super::driver_context::{ActiveCheck, BackupControllerDeps, BackupErrorHandler};
use super::jobs::{BackupJob, BackupJobKind, finish_backup_job, read_backup_jobs};
use super::requests::BackupRequestDeps;
use super::restore_publish::resume_restore;
use super::store::BackupStore;
use crate::controller::{ControllerMessageHandler, lock};
use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::transport::NodeTransport;

pub(crate) struct BackupServiceSettings {
    pub(crate) node_id: String,
    pub(crate) coordinator: Arc<EtcdCoordinator>,
    pub(crate) transport: Arc<dyn NodeTransport>,
    pub(crate) store: Option<BackupStore>,
    pub(crate) is_controller: ActiveCheck,
    pub(crate) on_error: BackupErrorHandler,
}

pub(crate) struct BackupService {
    pub(crate) requests: BackupRequestDeps,
    controller: Arc<BackupControllerDeps>,
    sweep: Mutex<Option<JoinHandle<()>>>,
}

fn abandoned_backup(job_id: &str, job: &BackupJob) -> ClusterError {
    ClusterError::new(
        codes::ALLOCATION_FAILED,
        format!(
            "The controller that ran backup '{}' stopped before it finished, so the backup stored no manifest",
            job.backup_name
        ),
    )
    .with_detail("backupName", Value::from(job.backup_name.as_str()))
    .with_detail("jobId", Value::from(job_id))
}

fn resume_run() -> BackupRun {
    Box::new(|context| Box::pin(resume_restore(context)))
}

async fn take_over_job(
    deps: &Arc<BackupControllerDeps>,
    store: &BackupStore,
    job_id: String,
    job: BackupJob,
) -> ClusterResult<()> {
    let run = match job.kind {
        BackupJobKind::Backup => {
            let abandoned = abandoned_backup(&job_id, &job);
            return finish_backup_job(&deps.coordinator, &job_id, Some(&abandoned)).await;
        }
        BackupJobKind::Delete => deletion_run(),
        BackupJobKind::Restore => resume_run(),
    };
    tokio::spawn(drive_backup_job(deps, store.clone(), job_id, job, run));
    Ok(())
}

async fn sweep(deps: &Arc<BackupControllerDeps>, store: &BackupStore) -> ClusterResult<()> {
    if !(deps.is_active)() {
        return Ok(());
    }
    for (job_id, job) in read_backup_jobs(&deps.coordinator).await? {
        if !job.is_running() || lock(&deps.driving).contains(&job_id) || !(deps.is_active)() {
            continue;
        }
        take_over_job(deps, store, job_id, job).await?;
    }
    Ok(())
}

impl BackupService {
    pub(crate) fn new(settings: BackupServiceSettings) -> BackupService {
        let BackupServiceSettings {
            node_id,
            coordinator,
            transport,
            store,
            is_controller,
            on_error,
        } = settings;
        let requests = BackupRequestDeps {
            coordinator: Arc::clone(&coordinator),
            transport: Arc::clone(&transport),
            node_id: node_id.clone(),
            store: store.clone(),
        };
        let controller = Arc::new(BackupControllerDeps {
            node_id,
            coordinator,
            transport,
            is_active: is_controller,
            on_error,
            store,
            driving: Mutex::new(HashSet::new()),
        });
        BackupService {
            requests,
            controller,
            sweep: Mutex::new(None),
        }
    }

    pub(crate) fn store(&self) -> Option<&BackupStore> {
        self.requests.store.as_ref()
    }

    pub(crate) fn controller_messages(&self) -> ControllerMessageHandler {
        let deps = Arc::clone(&self.controller);
        Arc::new(move |message, respond| {
            Box::pin(answer_backup_request(Arc::clone(&deps), message, respond))
        })
    }

    pub(crate) fn start(&self) {
        let Some(store) = self.controller.store.clone() else {
            return;
        };
        let mut sweeping = lock(&self.sweep);
        if sweeping.is_some() {
            return;
        }
        let deps = Arc::clone(&self.controller);
        *sweeping = Some(tokio::spawn(async move {
            let interval = Duration::from_millis(BACKUP_SWEEP_INTERVAL_MS);
            loop {
                if let Err(error) = sweep(&deps, &store).await {
                    (deps.on_error)(&error);
                }
                tokio::time::sleep(interval).await;
            }
        }));
    }

    pub(crate) fn stop(&self) {
        if let Some(sweeping) = lock(&self.sweep).take() {
            sweeping.abort();
        }
    }
}
