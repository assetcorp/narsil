use std::sync::Arc;

use narsil::{Map, Value};

use super::controller_checks::require_restorable_index_name;
use super::exchange::{Exchange, exchange_message, node_targets};
use super::job_wait::{BackupJobWait, await_backup_job};
use super::jobs::BackupJobKind;
use super::keys::validate_backup_name;
use super::store::{BackupStore, read_backup_manifest, summary_of};
use super::types::{
    BackupProgressHandler, BackupSummary, CreateBackupOptions, RestoreBackupOptions,
    RestoreConstraints,
};
use crate::constants::CONTROLLER_LEASE_KEY;
use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::message_types;
use crate::transport::NodeTransport;

pub(crate) type ShutdownGuard<'g> = &'g (dyn Fn() -> ClusterResult<()> + Sync);

pub(crate) struct BackupRequestDeps {
    pub(crate) coordinator: Arc<EtcdCoordinator>,
    pub(crate) transport: Arc<dyn NodeTransport>,
    pub(crate) node_id: String,
    pub(crate) store: Option<BackupStore>,
}

pub(crate) fn require_backup_store(store: Option<&BackupStore>) -> ClusterResult<&BackupStore> {
    store.ok_or_else(|| {
        ClusterError::new(
            codes::BACKUP_STORE_NOT_CONFIGURED,
            "This node has no backup store, so it takes no backup call. Set `backups` in the cluster node config.",
        )
    })
}

struct JobRequest<'r> {
    kind: BackupJobKind,
    message_type: &'static str,
    backup_name: &'r str,
    payload: Map,
    details: Map,
}

fn with_details(mut error: ClusterError, details: &Map) -> ClusterError {
    for (key, value) in details.iter() {
        error = error.with_detail(key, value.clone());
    }
    error
}

async fn run_job(
    deps: &BackupRequestDeps,
    guard: ShutdownGuard<'_>,
    request: JobRequest<'_>,
    on_progress: Option<&BackupProgressHandler>,
) -> ClusterResult<()> {
    guard()?;
    let kind = request.kind.as_str();
    let Some(controller_node_id) = deps.coordinator.lease_holder(CONTROLLER_LEASE_KEY).await?
    else {
        return Err(with_details(
            ClusterError::new(
                codes::NODE_NOT_CONTROLLER,
                format!(
                    "No node holds the controller lease, so the {kind} of backup '{}' cannot start",
                    request.backup_name
                ),
            ),
            &request.details,
        ));
    };
    let mut details = request.details.clone();
    details.insert("controllerNodeId", Value::from(controller_node_id.as_str()));
    let reply = exchange_message(Exchange {
        transport: deps.transport.as_ref(),
        sender_id: &deps.node_id,
        targets: node_targets(&deps.coordinator, &controller_node_id).await?,
        message_type: request.message_type,
        payload: Value::Object(request.payload),
        failure_message: format!(
            "The controller '{controller_node_id}' did not answer the {kind} of backup '{}'",
            request.backup_name
        ),
        details: details.clone(),
    })
    .await?;
    let Some(job_id) = reply
        .get("jobId")
        .and_then(Value::as_str)
        .filter(|job_id| !job_id.is_empty())
    else {
        return Err(with_details(
            ClusterError::new(
                codes::ALLOCATION_FAILED,
                format!(
                    "The controller sent an unreadable answer to the {kind} of backup '{}'",
                    request.backup_name
                ),
            ),
            &details,
        ));
    };
    await_backup_job(BackupJobWait {
        coordinator: &deps.coordinator,
        job_id,
        guard,
        on_progress,
    })
    .await?;
    Ok(())
}

async fn summary_after(store: &BackupStore, backup_name: &str) -> ClusterResult<BackupSummary> {
    let name = backup_name.to_string();
    store
        .run(move |store| read_backup_manifest(store, &name).map(|manifest| summary_of(&manifest)))
        .await
}

fn named_details(backup_name: &str, index_name: Option<&str>) -> Map {
    let mut details = Map::with_capacity(2);
    details.insert("backupName", Value::from(backup_name));
    if let Some(index_name) = index_name {
        details.insert("indexName", Value::from(index_name));
    }
    details
}

pub(crate) async fn request_backup(
    deps: &BackupRequestDeps,
    guard: ShutdownGuard<'_>,
    index_name: &str,
    backup_name: &str,
    options: &CreateBackupOptions,
) -> ClusterResult<BackupSummary> {
    let store = require_backup_store(deps.store.as_ref())?;
    let mut payload = Map::with_capacity(3);
    payload.insert(
        "backupName",
        Value::from(validate_backup_name(backup_name)?),
    );
    payload.insert(
        "indexName",
        Value::from(require_restorable_index_name(index_name)?),
    );
    if options.query_history {
        payload.insert("queryHistory", Value::Bool(true));
    }
    let request = JobRequest {
        kind: BackupJobKind::Backup,
        message_type: message_types::CLUSTER_BACKUP,
        backup_name,
        payload,
        details: named_details(backup_name, Some(index_name)),
    };
    run_job(deps, guard, request, options.on_progress.as_ref()).await?;
    summary_after(store, backup_name).await
}

pub(crate) async fn request_taken_backup(
    deps: &BackupRequestDeps,
    guard: ShutdownGuard<'_>,
    index_name: &str,
    backup_name: &str,
    taken_by: &'static str,
) -> ClusterResult<BackupSummary> {
    let store = require_backup_store(deps.store.as_ref())?;
    let mut payload = Map::with_capacity(3);
    payload.insert(
        "backupName",
        Value::from(validate_backup_name(backup_name)?),
    );
    payload.insert(
        "indexName",
        Value::from(require_restorable_index_name(index_name)?),
    );
    payload.insert("takenBy", Value::from(taken_by));
    let request = JobRequest {
        kind: BackupJobKind::Backup,
        message_type: message_types::CLUSTER_BACKUP,
        backup_name,
        payload,
        details: named_details(backup_name, Some(index_name)),
    };
    run_job(deps, guard, request, None).await?;
    summary_after(store, backup_name).await
}

fn constraints_payload(constraints: &RestoreConstraints) -> Value {
    let mut wire = Map::with_capacity(3);
    wire.insert("zoneAwareness", Value::Bool(constraints.zone_awareness));
    wire.insert(
        "zoneAttribute",
        Value::from(constraints.zone_attribute.as_str()),
    );
    if let Some(max_shards_per_node) = constraints.max_shards_per_node {
        wire.insert("maxShardsPerNode", Value::from(max_shards_per_node));
    }
    Value::Object(wire)
}

pub(crate) async fn request_restore(
    deps: &BackupRequestDeps,
    guard: ShutdownGuard<'_>,
    backup_name: &str,
    options: &RestoreBackupOptions,
) -> ClusterResult<BackupSummary> {
    let store = require_backup_store(deps.store.as_ref())?;
    let mut payload = Map::with_capacity(4);
    payload.insert(
        "backupName",
        Value::from(validate_backup_name(backup_name)?),
    );
    let index_name = require_restorable_index_name(&options.index_name)?;
    payload.insert("indexName", Value::from(index_name.as_str()));
    if let Some(replication_factor) = options.replication_factor {
        payload.insert("replicationFactor", Value::from(replication_factor));
    }
    if let Some(constraints) = &options.constraints {
        payload.insert("constraints", constraints_payload(constraints));
    }
    let request = JobRequest {
        kind: BackupJobKind::Restore,
        message_type: message_types::CLUSTER_BACKUP_RESTORE,
        backup_name,
        payload,
        details: named_details(backup_name, Some(&index_name)),
    };
    run_job(deps, guard, request, options.on_progress.as_ref()).await?;
    summary_after(store, backup_name).await
}

pub(crate) async fn request_backup_deletion(
    deps: &BackupRequestDeps,
    guard: ShutdownGuard<'_>,
    backup_name: &str,
    on_progress: Option<&BackupProgressHandler>,
) -> ClusterResult<()> {
    require_backup_store(deps.store.as_ref())?;
    let mut payload = Map::with_capacity(1);
    payload.insert(
        "backupName",
        Value::from(validate_backup_name(backup_name)?),
    );
    let request = JobRequest {
        kind: BackupJobKind::Delete,
        message_type: message_types::CLUSTER_BACKUP_DELETE,
        backup_name,
        payload,
        details: named_details(backup_name, None),
    };
    run_job(deps, guard, request, on_progress).await
}
