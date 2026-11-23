use std::sync::Arc;

use narsil::replication::BackupConstraints;
use narsil::{Map, Value, encode_msgpack};
use tokio::task::JoinHandle;

use super::controller_checks::{admit_backup, admit_deletion, admit_restore};
use super::driver_context::{BackupControllerDeps, BackupDriverContext};
use super::drivers::create::{BackupCreationRequest, run_backup_creation};
use super::drivers::delete::run_backup_deletion;
use super::drivers::restore::{RestoreRequest, run_backup_restore};
use super::jobs::{BackupJob, BackupJobKind, finish_backup_job, start_backup_job};
use super::keys::validate_backup_value;
use super::manifest::{
    CHANGES_BACKUP_TAKER, SYNC_BACKUP_TAKER, is_backup_taker, read_allocation_constraints,
};
use super::store::BackupStore;
use super::sync_retention::surplus_taken_backups;
use crate::constants::MAX_REPLICATION_FACTOR;
use crate::controller::lock;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{TransportMessage, message_types, refusal};
use crate::node::{decode_request_payload, generate_node_id};
use crate::transport::{BoxFuture, Respond};

pub(crate) type BackupRun =
    Box<dyn FnOnce(BackupDriverContext) -> BoxFuture<'static, ClusterResult<()>> + Send>;

fn kind_of(message_type: &str) -> Option<BackupJobKind> {
    match message_type {
        message_types::CLUSTER_BACKUP => Some(BackupJobKind::Backup),
        message_types::CLUSTER_BACKUP_RESTORE => Some(BackupJobKind::Restore),
        message_types::CLUSTER_BACKUP_DELETE => Some(BackupJobKind::Delete),
        _ => None,
    }
}

fn malformed(kind: BackupJobKind, reason: &str) -> ClusterError {
    ClusterError::new(
        codes::CONFIG_INVALID,
        format!(
            "The {} request for a backup is malformed: {reason}",
            kind.as_str()
        ),
    )
    .with_detail("kind", Value::from(kind.as_str()))
}

fn decode_request(kind: BackupJobKind, message: &TransportMessage) -> ClusterResult<Map> {
    match decode_request_payload(&message.payload, &message.message_type)? {
        Value::Object(request) => Ok(request),
        _ => Err(malformed(kind, "expected an object")),
    }
}

fn index_name_of(kind: BackupJobKind, request: &Map) -> ClusterResult<String> {
    match request.get("indexName") {
        Some(Value::String(index_name)) if !index_name.is_empty() => Ok(index_name.clone()),
        _ => Err(malformed(kind, "\"indexName\" must be a non-empty string")),
    }
}

fn is_absent(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null))
}

fn restore_options_of(request: &Map) -> ClusterResult<(Option<f64>, Option<BackupConstraints>)> {
    let replication_factor = match request.get("replicationFactor") {
        found if is_absent(found) => None,
        Some(Value::Number(factor))
            if factor.fract() == 0.0 && (0.0..=MAX_REPLICATION_FACTOR).contains(factor) =>
        {
            Some(*factor)
        }
        _ => {
            return Err(malformed(
                BackupJobKind::Restore,
                &format!(
                    "\"replicationFactor\" must be an integer from 0 to {MAX_REPLICATION_FACTOR}"
                ),
            ));
        }
    };
    let constraints = match request.get("constraints") {
        None | Some(Value::Null) => None,
        Some(raw) => Some(read_allocation_constraints(raw).ok_or_else(|| {
            malformed(
                BackupJobKind::Restore,
                "\"constraints\" must hold \"zoneAwareness\" as a boolean, \"zoneAttribute\" as a non-empty string, and \"maxShardsPerNode\" as a positive integer, or leave any of them out",
            )
        })?),
    };
    Ok((replication_factor, constraints))
}

fn taken_by_of(request: &Map) -> ClusterResult<Option<String>> {
    match request.get("takenBy") {
        found if is_absent(found) => Ok(None),
        Some(Value::String(taker)) if is_backup_taker(taker) => Ok(Some(taker.clone())),
        _ => Err(malformed(
            BackupJobKind::Backup,
            &format!("\"takenBy\" must be \"{SYNC_BACKUP_TAKER}\" or \"{CHANGES_BACKUP_TAKER}\""),
        )),
    }
}

fn query_history_of(request: &Map) -> ClusterResult<bool> {
    match request.get("queryHistory") {
        found if is_absent(found) => Ok(false),
        Some(Value::Bool(requested)) => Ok(*requested),
        _ => Err(malformed(
            BackupJobKind::Backup,
            "\"queryHistory\" must be a boolean",
        )),
    }
}

fn require_store(deps: &BackupControllerDeps) -> ClusterResult<BackupStore> {
    deps.store.clone().ok_or_else(|| {
        ClusterError::new(
            codes::BACKUP_STORE_NOT_CONFIGURED,
            format!(
                "The controller '{}' has no backup store. Give every node the same `backups` setting.",
                deps.node_id
            ),
        )
        .with_detail("nodeId", Value::from(deps.node_id.as_str()))
    })
}

struct DrivingTurn {
    deps: Arc<BackupControllerDeps>,
    job_id: String,
}

impl DrivingTurn {
    fn take(deps: &Arc<BackupControllerDeps>, job_id: &str) -> DrivingTurn {
        lock(&deps.driving).insert(job_id.to_string());
        DrivingTurn {
            deps: Arc::clone(deps),
            job_id: job_id.to_string(),
        }
    }
}

impl Drop for DrivingTurn {
    fn drop(&mut self) {
        lock(&self.deps.driving).remove(&self.job_id);
    }
}

pub(crate) fn drive_backup_job(
    deps: &Arc<BackupControllerDeps>,
    store: BackupStore,
    job_id: String,
    job: BackupJob,
    run: BackupRun,
) -> BoxFuture<'static, ()> {
    drive_with_turn(DrivingTurn::take(deps, &job_id), store, job, run)
}

fn drive_with_turn(
    turn: DrivingTurn,
    store: BackupStore,
    job: BackupJob,
    run: BackupRun,
) -> BoxFuture<'static, ()> {
    let context = BackupDriverContext {
        deps: Arc::clone(&turn.deps),
        store,
        job_id: turn.job_id.clone(),
        job,
    };
    Box::pin(async move {
        let deps = Arc::clone(&turn.deps);
        let finished = match run(context).await {
            Ok(()) => finish_backup_job(&deps.coordinator, &turn.job_id, None).await,
            Err(error) if (deps.is_active)() => {
                finish_backup_job(&deps.coordinator, &turn.job_id, Some(&error)).await
            }
            Err(error) => {
                (deps.on_error)(&error);
                Ok(())
            }
        };
        if let Err(error) = finished {
            (deps.on_error)(&error);
        }
        drop(turn);
    })
}

async fn start_job(
    deps: &Arc<BackupControllerDeps>,
    store: &BackupStore,
    job: BackupJob,
    run: BackupRun,
    after_job: Option<BoxFuture<'static, ClusterResult<()>>>,
) -> ClusterResult<(String, JoinHandle<()>)> {
    let job_id = generate_node_id()?;
    let turn = DrivingTurn::take(deps, &job_id);
    start_backup_job(&deps.coordinator, &job_id, &job).await?;
    let driven = drive_with_turn(turn, store.clone(), job, run);
    let on_error = Arc::clone(&deps.on_error);
    let ended = tokio::spawn(async move {
        driven.await;
        if let Some(after_job) = after_job
            && let Err(error) = after_job.await
        {
            on_error(&error);
        }
    });
    Ok((job_id, ended))
}

pub(crate) fn deletion_run() -> BackupRun {
    Box::new(|context| Box::pin(run_backup_deletion(context)))
}

fn quiet_refusal(error: &ClusterError) -> bool {
    error.code() == codes::BACKUP_IN_PROGRESS || error.code() == codes::BACKUP_NOT_FOUND
}

async fn delete_surplus_taken_backups(
    deps: Arc<BackupControllerDeps>,
    store: BackupStore,
    index_name: String,
    taken_by: String,
) -> ClusterResult<()> {
    let surplus = store
        .run(move |store| surplus_taken_backups(store, &index_name, &taken_by))
        .await?;
    for backup_name in surplus {
        if !(deps.is_active)() {
            return Ok(());
        }
        let deleted = async {
            admit_deletion(&deps.coordinator, &store, &backup_name).await?;
            let job = BackupJob::running(BackupJobKind::Delete, &backup_name, None);
            let (_, ended) = start_job(&deps, &store, job, deletion_run(), None).await?;
            let _ = ended.await;
            Ok(())
        }
        .await;
        if let Err(error) = deleted
            && !quiet_refusal(&error)
        {
            return Err(error);
        }
    }
    Ok(())
}

async fn accept_backup(
    deps: &Arc<BackupControllerDeps>,
    store: BackupStore,
    request: &Map,
    backup_name: String,
) -> ClusterResult<String> {
    let kind = BackupJobKind::Backup;
    let index_name = index_name_of(kind, request)?;
    let taken_by = taken_by_of(request)?;
    let query_history = query_history_of(request)?;
    admit_backup(&deps.coordinator, &store, &backup_name, &index_name).await?;
    let after_job = taken_by
        .clone()
        .map(|taker| -> BoxFuture<'static, ClusterResult<()>> {
            Box::pin(delete_surplus_taken_backups(
                Arc::clone(deps),
                store.clone(),
                index_name.clone(),
                taker,
            ))
        });
    let creation = BackupCreationRequest {
        taken_by,
        query_history,
    };
    let run: BackupRun = Box::new(move |context| Box::pin(run_backup_creation(context, creation)));
    let job = BackupJob::running(kind, &backup_name, Some(&index_name));
    Ok(start_job(deps, &store, job, run, after_job).await?.0)
}

async fn accept_restore(
    deps: &Arc<BackupControllerDeps>,
    store: BackupStore,
    request: &Map,
    backup_name: String,
) -> ClusterResult<String> {
    let kind = BackupJobKind::Restore;
    let index_name = index_name_of(kind, request)?;
    let (replication_factor, constraints) = restore_options_of(request)?;
    let manifest = admit_restore(&deps.coordinator, &store, &backup_name, &index_name).await?;
    let restore = RestoreRequest {
        manifest,
        replication_factor,
        constraints,
    };
    let run: BackupRun = Box::new(move |context| Box::pin(run_backup_restore(context, restore)));
    let job = BackupJob::running(kind, &backup_name, Some(&index_name));
    Ok(start_job(deps, &store, job, run, None).await?.0)
}

async fn accept_request(
    deps: &Arc<BackupControllerDeps>,
    kind: BackupJobKind,
    message: &TransportMessage,
) -> ClusterResult<String> {
    if !(deps.is_active)() {
        return Err(ClusterError::new(
            codes::NODE_NOT_CONTROLLER,
            format!("Node '{}' does not hold the controller lease", deps.node_id),
        )
        .with_detail("nodeId", Value::from(deps.node_id.as_str())));
    }
    let store = require_store(deps)?;
    let request = decode_request(kind, message)?;
    let backup_name = validate_backup_value(request.get("backupName"))?;
    match kind {
        BackupJobKind::Backup => accept_backup(deps, store, &request, backup_name).await,
        BackupJobKind::Restore => accept_restore(deps, store, &request, backup_name).await,
        BackupJobKind::Delete => {
            admit_deletion(&deps.coordinator, &store, &backup_name).await?;
            let job = BackupJob::running(kind, &backup_name, None);
            Ok(start_job(deps, &store, job, deletion_run(), None).await?.0)
        }
    }
}

fn accepted(
    message: &TransportMessage,
    node_id: &str,
    job_id: String,
) -> ClusterResult<TransportMessage> {
    let mut payload = Map::with_capacity(1);
    payload.insert("jobId", Value::String(job_id));
    Ok(TransportMessage::new(
        message.message_type.clone(),
        node_id,
        message.request_id.clone(),
        encode_msgpack(&Value::Object(payload))?,
    ))
}

pub(crate) async fn answer_backup_request(
    deps: Arc<BackupControllerDeps>,
    message: TransportMessage,
    respond: Respond,
) {
    let Some(kind) = kind_of(&message.message_type) else {
        return;
    };
    let reply = accept_request(&deps, kind, &message)
        .await
        .and_then(|job_id| accepted(&message, &deps.node_id, job_id))
        .unwrap_or_else(|error| refusal(&message, &deps.node_id, &error));
    respond.send(reply).await;
}
