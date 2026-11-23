use std::sync::{Arc, Mutex};

use narsil::Value;
use narsil::replication::{
    BackupConstraints, BackupManifest, BackupPartition, StoredFile, backup_partition,
    encode_backup_manifest, stored_file,
};

use super::super::config_agreement::{
    agreed_config_of, config_with_suggestion_state, suggestion_state_of_settings,
};
use super::super::constants::BACKUP_PARTITIONS_AT_ONCE;
use super::super::controller_checks::serving_name_of;
use super::super::driver_context::BackupDriverContext;
use super::super::files::first_unstored_file;
use super::super::manifest::stored_files_of;
use super::super::partition_exchange::{PartitionTask, drive_partition_task, for_each_partition};
use super::super::store::{backup_name_taken, claim_backup_store, cluster_uuid_of, holds_manifest};
use crate::controller::{lock, now_ms, stored_index_metadata};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::message_types;

pub(crate) struct BackupCreationRequest {
    pub(crate) taken_by: Option<String>,
    pub(crate) query_history: bool,
}

struct PartitionResult {
    partition: BackupPartition,
    config: StoredFile,
}

fn unreadable_result(backup_name: &str, partition_id: u32) -> ClusterError {
    ClusterError::new(
        codes::ALLOCATION_FAILED,
        format!("The primary of partition {partition_id} sent an unreadable result for backup '{backup_name}'"),
    )
    .with_detail("backupName", Value::from(backup_name))
    .with_detail("partitionId", Value::from(partition_id))
}

fn is_whole(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Number(number)) if number.is_finite() && number.fract() == 0.0)
}

fn read_partition_result(
    value: Option<&Value>,
    backup_name: &str,
    partition_id: u32,
    partition_count: u64,
) -> ClusterResult<PartitionResult> {
    let unreadable = || unreadable_result(backup_name, partition_id);
    let fields = value.and_then(Value::as_object).ok_or_else(unreadable)?;
    if !is_whole(fields.get("filesStored")) || !is_whole(fields.get("bytesStored")) {
        return Err(unreadable());
    }
    let partition = fields
        .get("partition")
        .ok_or_else(unreadable)
        .and_then(|entry| {
            backup_partition(entry, backup_name, partition_count as f64).map_err(|_| unreadable())
        })?;
    if partition.partition_id != u64::from(partition_id) {
        return Err(unreadable());
    }
    let config = stored_file(fields.get("config"), backup_name).map_err(|_| unreadable())?;
    Ok(PartitionResult { partition, config })
}

async fn back_up_every_partition(
    context: &BackupDriverContext,
    generation: &str,
    partition_count: u64,
) -> ClusterResult<Vec<PartitionResult>> {
    let results: Arc<Mutex<Vec<Option<PartitionResult>>>> =
        Arc::new(Mutex::new((0..partition_count).map(|_| None).collect()));
    let done = Arc::new(Mutex::new(0u64));
    let (shared, generation_name) = (context.clone(), generation.to_string());
    let collected = Arc::clone(&results);
    for_each_partition(
        partition_count as u32,
        BACKUP_PARTITIONS_AT_ONCE,
        move |partition_id| {
            let (context, generation, results, done) = (
                shared.clone(),
                generation_name.clone(),
                Arc::clone(&collected),
                Arc::clone(&done),
            );
            async move {
                let task = PartitionTask {
                    message_type: message_types::CLUSTER_BACKUP_PARTITION,
                    job_id: context.job_id.clone(),
                    backup_name: context.job.backup_name.clone(),
                    index_name: generation,
                    partition_id,
                };
                let outcome = drive_partition_task(&context, &task).await?;
                let result = read_partition_result(
                    outcome.result.as_ref(),
                    &context.job.backup_name,
                    partition_id,
                    partition_count,
                )?;
                lock(&results)[partition_id as usize] = Some(result);
                let finished = {
                    let mut done = lock(&done);
                    *done += 1;
                    *done
                };
                context.report_job_progress(finished, partition_count).await
            }
        },
    )
    .await?;
    let taken = std::mem::take(&mut *lock(&results));
    taken
        .into_iter()
        .enumerate()
        .map(|(partition_id, result)| {
            result.ok_or_else(|| unreadable_result(&context.job.backup_name, partition_id as u32))
        })
        .collect()
}

fn epoch_features_on(settings: Option<&Value>) -> bool {
    let enabled = |key: &str| {
        settings
            .and_then(Value::as_object)
            .and_then(|fields| fields.get(key))
            .and_then(Value::as_object)
            .and_then(|feature| feature.get("enabled"))
            == Some(&Value::Bool(true))
    };
    enabled("sync") || enabled("changes")
}

fn sync_epoch_of(settings: Option<&Value>) -> Option<String> {
    if !epoch_features_on(settings) {
        return None;
    }
    settings
        .and_then(Value::as_object)
        .and_then(|fields| fields.get("syncEpoch"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

pub(crate) async fn run_backup_creation(
    context: BackupDriverContext,
    request: BackupCreationRequest,
) -> ClusterResult<()> {
    let coordinator = context.coordinator();
    let index_name = context.job_index_name()?;
    let generation = serving_name_of(coordinator, &index_name).await?;
    let named = stored_index_metadata(coordinator, &index_name)
        .await?
        .and_then(|(_, settings)| settings);
    let sync_epoch = sync_epoch_of(named.as_ref());
    let Some((metadata, _)) = stored_index_metadata(coordinator, &generation).await? else {
        return Err(ClusterError::new(
            codes::INDEX_NOT_FOUND,
            format!("Index '{index_name}' does not exist in the cluster"),
        )
        .with_detail("indexName", Value::from(index_name.as_str())));
    };
    let partition_count = metadata.partition_count as u64;
    let cluster_uuid = cluster_uuid_of(coordinator).await?;
    context.report_job_progress(0, partition_count).await?;
    let results = back_up_every_partition(&context, &generation, partition_count).await?;
    let configs: Vec<StoredFile> = results.iter().map(|result| result.config.clone()).collect();
    let partitions: Vec<BackupPartition> =
        results.into_iter().map(|result| result.partition).collect();
    let agreed = agreed_config_of(&context, configs, &index_name).await?;
    let config = config_with_suggestion_state(
        &context,
        agreed,
        suggestion_state_of_settings(named.as_ref()),
    )
    .await?;
    let backup_name = context.job.backup_name.clone();
    let manifest = BackupManifest {
        name: backup_name.clone(),
        cluster_uuid: cluster_uuid.clone(),
        index_name: index_name.clone(),
        started_at: context.job.started_at,
        completed_at: now_ms(),
        partition_count,
        sync_epoch,
        taken_by: request.taken_by,
        replication_factor: metadata.replication_factor,
        constraints: BackupConstraints {
            zone_awareness: metadata.constraints.zone_awareness,
            zone_attribute: metadata.constraints.zone_attribute.clone(),
            max_shards_per_node: metadata.constraints.max_shards_per_node,
        },
        config,
        query_history: request.query_history.then(Vec::new),
        partitions,
    };
    let checked = manifest.clone();
    let unstored = context
        .store
        .run(move |store| Ok(first_unstored_file(store, &stored_files_of(&checked))?.cloned()))
        .await?;
    if let Some(unstored) = unstored {
        return Err(ClusterError::new(
            codes::PERSISTENCE_SAVE_FAILED,
            format!(
                "The store lacks the file {} that backup '{backup_name}' lists, so it stores no manifest",
                unstored.sha256
            ),
        )
        .with_detail("backupName", Value::from(backup_name.as_str()))
        .with_detail("sha256", Value::from(unstored.sha256.as_str())));
    }
    context.assert_still_driving()?;
    let name = backup_name.clone();
    let taken = context
        .store
        .run(move |store| {
            claim_backup_store(store, &cluster_uuid)?;
            holds_manifest(store, &name)
        })
        .await?;
    if taken {
        return Err(backup_name_taken(&backup_name));
    }
    context
        .report_job_progress(partition_count, partition_count)
        .await?;
    let encoded = encode_backup_manifest(&manifest)?;
    context
        .store
        .run(move |store| store.save(&store.keys.manifest(&backup_name)?, &encoded))
        .await
}
