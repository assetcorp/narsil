use std::sync::Arc;

use narsil::{Map, Value, encode_msgpack};

use super::constants::BACKUP_FILES_AT_ONCE;
use super::keys::validate_backup_value;
use super::primary_backup::back_up_partition;
use super::primary_restore::{RestoreTarget, restore_partition};
use super::primary_tasks::{PartitionTaskRef, PartitionTasks};
use super::store::{BackupStore, read_backup_manifest};
use super::transfer_limit::TransferLimit;
use crate::allocator::{Assignment, INITIALISING};
use crate::constants::MAX_PARTITION_COUNT;
use crate::controller::{index_metadata, stored_table};
use crate::coordinator::etcd::EtcdCoordinator;
use crate::data::PrimaryWrites;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::TransportMessage;
use crate::node::decode_request_payload;

pub(crate) struct BackupPrimary {
    store: BackupStore,
    limit: Arc<TransferLimit>,
    backups: PartitionTasks,
    restores: PartitionTasks,
}

impl BackupPrimary {
    pub(crate) fn new(store: BackupStore) -> BackupPrimary {
        BackupPrimary {
            store,
            limit: Arc::new(TransferLimit::new(BACKUP_FILES_AT_ONCE)),
            backups: PartitionTasks::default(),
            restores: PartitionTasks::default(),
        }
    }
}

pub(crate) struct PrimaryContext<'c> {
    pub(crate) node_id: &'c str,
    pub(crate) coordinator: &'c Arc<EtcdCoordinator>,
    pub(crate) writes: Arc<PrimaryWrites>,
}

struct PartitionTaskPayload {
    job_id: String,
    backup_name: String,
    index_name: String,
    partition_id: u32,
}

impl PartitionTaskPayload {
    fn task(&self) -> PartitionTaskRef<'_> {
        PartitionTaskRef {
            job_id: &self.job_id,
            index_name: &self.index_name,
            partition_id: self.partition_id,
        }
    }
}

fn invalid(what: &str) -> ClusterError {
    ClusterError::new(
        codes::CONFIG_INVALID,
        format!("Invalid backup partition message: {what}"),
    )
}

fn non_empty_text(fields: &Map, key: &str) -> Option<String> {
    match fields.get(key) {
        Some(Value::String(text)) if !text.is_empty() => Some(text.clone()),
        _ => None,
    }
}

fn read_payload(message: &TransportMessage) -> ClusterResult<PartitionTaskPayload> {
    let decoded = decode_request_payload(&message.payload, &message.message_type)?;
    let Value::Object(fields) = decoded else {
        return Err(invalid("expected an object"));
    };
    let job_id = non_empty_text(&fields, "jobId")
        .ok_or_else(|| invalid("\"jobId\" must be a non-empty string"))?;
    let index_name = non_empty_text(&fields, "indexName")
        .ok_or_else(|| invalid("\"indexName\" must be a non-empty string"))?;
    let partition_id = match fields.get("partitionId") {
        Some(Value::Number(id)) if id.fract() == 0.0 && *id >= 0.0 && *id < MAX_PARTITION_COUNT => {
            *id as u32
        }
        _ => {
            return Err(invalid(&format!(
                "\"partitionId\" must be an integer from 0 to {}",
                MAX_PARTITION_COUNT - 1.0
            )));
        }
    };
    let backup_name = validate_backup_value(fields.get("backupName"))?;
    Ok(PartitionTaskPayload {
        job_id,
        backup_name,
        index_name,
        partition_id,
    })
}

pub(crate) fn require_primary<'p>(
    primary: Option<&'p Arc<BackupPrimary>>,
    node_id: &str,
) -> ClusterResult<&'p Arc<BackupPrimary>> {
    primary.ok_or_else(|| {
        ClusterError::new(
            codes::BACKUP_STORE_NOT_CONFIGURED,
            format!(
                "Node '{node_id}' has no backup store, so it takes no part in a backup. Give every node the same `backups` setting."
            ),
        )
        .with_detail("nodeId", Value::from(node_id))
    })
}

async fn refuse_initialising_partition(
    context: &PrimaryContext<'_>,
    payload: &PartitionTaskPayload,
) -> ClusterResult<()> {
    let Ok(Some(table)) = stored_table(context.coordinator, &payload.index_name).await else {
        return Ok(());
    };
    let initialising = table
        .assignments
        .get(f64::from(payload.partition_id))
        .is_some_and(|assignment| assignment.state == INITIALISING);
    if !initialising {
        return Ok(());
    }
    Err(ClusterError::new(
        codes::QUERY_NO_ACTIVE_REPLICA,
        format!(
            "Node '{}' serves no read, because partition {} of index '{}' is INITIALISING",
            context.node_id, payload.partition_id, payload.index_name
        ),
    )
    .with_detail("indexName", Value::from(payload.index_name.as_str()))
    .with_detail("partitionId", Value::from(payload.partition_id))
    .with_detail("nodeId", Value::from(context.node_id)))
}

async fn local_assignment(
    context: &PrimaryContext<'_>,
    payload: &PartitionTaskPayload,
) -> ClusterResult<Assignment> {
    let table = stored_table(context.coordinator, &payload.index_name).await?;
    let assignment = table
        .as_ref()
        .and_then(|table| table.assignments.get(f64::from(payload.partition_id)));
    match assignment {
        Some(assignment) if assignment.primary.as_deref() == Some(context.node_id) => {
            Ok(assignment.clone())
        }
        _ => Err(ClusterError::new(
            codes::PARTITION_NOT_PRIMARY,
            format!(
                "Node '{}' is not primary for partition {} of index '{}'",
                context.node_id, payload.partition_id, payload.index_name
            ),
        )
        .with_detail("indexName", Value::from(payload.index_name.as_str()))
        .with_detail("partitionId", Value::from(payload.partition_id))
        .with_detail(
            "primaryNodeId",
            assignment
                .and_then(|assignment| assignment.primary.clone())
                .map_or(Value::Null, Value::String),
        )
        .with_detail("localNodeId", Value::from(context.node_id))),
    }
}

fn reply(
    message: &TransportMessage,
    node_id: &str,
    state: &Value,
) -> ClusterResult<TransportMessage> {
    Ok(TransportMessage::new(
        message.message_type.as_str(),
        node_id,
        message.request_id.as_str(),
        encode_msgpack(state)?,
    ))
}

pub(crate) async fn answer_backup_partition(
    primary: Option<&Arc<BackupPrimary>>,
    context: PrimaryContext<'_>,
    message: &TransportMessage,
) -> ClusterResult<TransportMessage> {
    let payload = read_payload(message)?;
    let primary = require_primary(primary, context.node_id)?;
    refuse_initialising_partition(&context, &payload).await?;
    local_assignment(&context, &payload).await?;
    let (store, limit, writes) = (
        primary.store.clone(),
        Arc::clone(&primary.limit),
        Arc::clone(&context.writes),
    );
    let (index_name, partition_id) = (payload.index_name.clone(), payload.partition_id);
    let state = primary.backups.poll(&payload.task(), move || async move {
        let source = writes.backup_partition(&index_name, partition_id).await?;
        let result = store
            .run(move |store| back_up_partition(store, &limit, &source, partition_id))
            .await?;
        Ok(Some(result))
    });
    reply(message, context.node_id, &state)
}

fn index_not_found(generation: &str) -> ClusterError {
    ClusterError::new(
        codes::INDEX_NOT_FOUND,
        format!("Index '{generation}' has no schema or metadata to restore into"),
    )
    .with_detail("indexName", Value::from(generation))
}

struct RestoreJob {
    store: BackupStore,
    limit: Arc<TransferLimit>,
    writes: Arc<PrimaryWrites>,
    coordinator: Arc<EtcdCoordinator>,
    payload: PartitionTaskPayload,
    primary_term: u64,
}

async fn restore_one_partition(job: RestoreJob) -> ClusterResult<Option<Value>> {
    let generation = job.payload.index_name.as_str();
    let schema = job.coordinator.schema(generation).await?;
    let metadata = index_metadata(&job.coordinator, generation).await?;
    let (Some(_), Some(metadata)) = (schema, metadata) else {
        return Err(index_not_found(generation));
    };
    let backup_name = job.payload.backup_name.clone();
    let backup = job
        .store
        .run(move |store| read_backup_manifest(store, &backup_name))
        .await?;
    let target = RestoreTarget {
        generation,
        partition_id: job.payload.partition_id,
        primary_term: job.primary_term,
        partition_count: metadata.partition_count as u64,
    };
    restore_partition(&job.store, &job.limit, &job.writes, backup, &target).await?;
    Ok(None)
}

pub(crate) async fn answer_restore_partition(
    primary: Option<&Arc<BackupPrimary>>,
    context: PrimaryContext<'_>,
    message: &TransportMessage,
) -> ClusterResult<TransportMessage> {
    let payload = read_payload(message)?;
    let primary = require_primary(primary, context.node_id)?;
    let assignment = local_assignment(&context, &payload).await?;
    let task_key = PartitionTaskPayload {
        job_id: payload.job_id.clone(),
        backup_name: payload.backup_name.clone(),
        index_name: payload.index_name.clone(),
        partition_id: payload.partition_id,
    };
    let job = RestoreJob {
        store: primary.store.clone(),
        limit: Arc::clone(&primary.limit),
        writes: Arc::clone(&context.writes),
        coordinator: Arc::clone(context.coordinator),
        payload,
        primary_term: assignment.primary_term as u64,
    };
    let state = primary
        .restores
        .poll(&task_key.task(), move || restore_one_partition(job));
    reply(message, context.node_id, &state)
}
