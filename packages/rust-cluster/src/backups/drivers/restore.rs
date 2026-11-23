use std::sync::{Arc, Mutex};

use narsil::Value;
use narsil::replication::{BackupConstraints, BackupManifest};

use super::super::constants::BACKUP_PARTITIONS_AT_ONCE;
use super::super::driver_context::BackupDriverContext;
use super::super::files::{damaged_file, first_unstored_file, load_checked_bytes};
use super::super::index_config::{
    RestorableConfig, RestoredIndexShape, decode_backup_index_config, write_restored_metadata,
};
use super::super::manifest::stored_files_of;
use super::super::partition_exchange::{PartitionTask, drive_partition_task, for_each_partition};
use super::super::query_history::write_restored_history;
use super::super::replication_factor::request_replication_factor;
use super::super::restore_publish::{
    drop_unpublished_generation, name_taken, publish_restored_name,
};
use crate::constants::HIDDEN_GENERATION_PREFIX;
use crate::controller::{index_metadata, lock, stored_table};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::message_types;
use crate::node::generate_node_id;

pub(crate) struct RestoreRequest {
    pub(crate) manifest: BackupManifest,
    pub(crate) replication_factor: Option<f64>,
    pub(crate) constraints: Option<BackupConstraints>,
}

async fn read_restorable_config(
    context: &BackupDriverContext,
    manifest: &BackupManifest,
) -> ClusterResult<RestorableConfig> {
    let checked = manifest.clone();
    let bytes = context
        .store
        .run(move |store| {
            if let Some(unstored) = first_unstored_file(store, &stored_files_of(&checked))? {
                return Err(damaged_file(
                    &checked.name,
                    unstored,
                    "is missing from the store",
                ));
            }
            load_checked_bytes(store, &checked.config, &checked.name)
        })
        .await?;
    decode_backup_index_config(&bytes, &manifest.name)
}

async fn create_generation(
    context: &BackupDriverContext,
    restorable: &RestorableConfig,
    manifest: &BackupManifest,
    generation: &str,
    constraints: &BackupConstraints,
) -> ClusterResult<()> {
    let coordinator = context.coordinator();
    let shape = RestoredIndexShape {
        index_name: generation,
        index_uuid: &generation[HIDDEN_GENERATION_PREFIX.len()..],
        partition_count: manifest.partition_count,
        replication_factor: 0.0,
        constraints,
    };
    if !write_restored_metadata(coordinator, restorable, &shape, false).await? {
        return Err(ClusterError::new(
            codes::ALLOCATION_FAILED,
            format!("The restore found '{generation}' already written"),
        )
        .with_detail("generation", Value::from(generation)));
    }
    context.assert_still_driving()?;
    coordinator.put_schema(generation, &restorable.schema).await
}

async fn restore_every_partition(
    context: &BackupDriverContext,
    generation: &str,
    manifest: &BackupManifest,
) -> ClusterResult<Vec<(u32, f64)>> {
    let partition_count = manifest.partition_count;
    let terms: Arc<Mutex<Vec<(u32, f64)>>> = Arc::new(Mutex::new(Vec::new()));
    let (shared, generation_name, collected) =
        (context.clone(), generation.to_string(), Arc::clone(&terms));
    for_each_partition(
        partition_count as u32,
        BACKUP_PARTITIONS_AT_ONCE,
        move |partition_id| {
            let (context, generation, terms) = (
                shared.clone(),
                generation_name.clone(),
                Arc::clone(&collected),
            );
            async move {
                let task = PartitionTask {
                    message_type: message_types::CLUSTER_RESTORE_PARTITION,
                    job_id: context.job_id.clone(),
                    backup_name: context.job.backup_name.clone(),
                    index_name: generation,
                    partition_id,
                };
                let outcome = drive_partition_task(&context, &task).await?;
                let done = {
                    let mut terms = lock(&terms);
                    terms.push((partition_id, outcome.primary_term));
                    terms.len() as u64
                };
                context.report_job_progress(done, partition_count).await
            }
        },
    )
    .await?;
    Ok(std::mem::take(&mut *lock(&terms)))
}

async fn require_unmoved_primaries(
    context: &BackupDriverContext,
    generation: &str,
    terms: &[(u32, f64)],
) -> ClusterResult<()> {
    let table = stored_table(context.coordinator(), generation).await?;
    for (partition_id, term) in terms {
        let current = table
            .as_ref()
            .and_then(|table| table.assignments.get(f64::from(*partition_id)))
            .map(|assignment| assignment.primary_term);
        if current == Some(*term) {
            continue;
        }
        return Err(ClusterError::new(
            codes::ALLOCATION_FAILED,
            format!(
                "The primary of restored partition {partition_id} changed before the index was ready, so the restore creates no index"
            ),
        )
        .with_detail("generation", Value::from(generation))
        .with_detail("partitionId", Value::from(*partition_id)));
    }
    Ok(())
}

async fn restore_into_generation(
    context: &BackupDriverContext,
    request: &RestoreRequest,
    restorable: &RestorableConfig,
    generation: &str,
    constraints: &BackupConstraints,
) -> ClusterResult<()> {
    let manifest = &request.manifest;
    create_generation(context, restorable, manifest, generation, constraints).await?;
    let terms = restore_every_partition(context, generation, manifest).await?;
    let replication_factor = request
        .replication_factor
        .unwrap_or(manifest.replication_factor);
    if replication_factor > 0.0 {
        context.assert_still_driving()?;
        request_replication_factor(
            context.coordinator(),
            context.deps.transport.as_ref(),
            context.node_id(),
            generation,
            replication_factor,
        )
        .await?;
    }
    require_unmoved_primaries(context, generation, &terms).await
}

async fn check_restored_history(
    context: &BackupDriverContext,
    manifest: &BackupManifest,
) -> ClusterResult<()> {
    for file in manifest.query_history.iter().flatten() {
        context.assert_still_driving()?;
        let (checked, backup_name) = (file.clone(), manifest.name.clone());
        context
            .store
            .run(move |store| load_checked_bytes(store, &checked, &backup_name).map(|_| ()))
            .await?;
    }
    Ok(())
}

async fn write_name_metadata(
    context: &BackupDriverContext,
    restorable: &RestorableConfig,
    request: &RestoreRequest,
    constraints: &BackupConstraints,
    index_uuid: &str,
) -> ClusterResult<bool> {
    let index_name = context.job_index_name()?;
    let shape = RestoredIndexShape {
        index_name: &index_name,
        index_uuid,
        partition_count: request.manifest.partition_count,
        replication_factor: request
            .replication_factor
            .unwrap_or(request.manifest.replication_factor),
        constraints,
    };
    match write_restored_metadata(context.coordinator(), restorable, &shape, true).await {
        Ok(written) => Ok(written),
        Err(error) => {
            let written = index_metadata(context.coordinator(), &index_name)
                .await
                .ok()
                .flatten();
            if written.is_some_and(|metadata| metadata.index_uuid == index_uuid) {
                return Ok(true);
            }
            Err(error)
        }
    }
}

async fn restore_and_name(
    context: &BackupDriverContext,
    request: &RestoreRequest,
    restorable: &RestorableConfig,
    generation: &str,
    name_index_uuid: &str,
) -> ClusterResult<()> {
    let index_name = context.job_index_name()?;
    let constraints = request
        .constraints
        .clone()
        .unwrap_or_else(|| request.manifest.constraints.clone());
    restore_into_generation(context, request, restorable, generation, &constraints).await?;
    check_restored_history(context, &request.manifest).await?;
    if let Some(query_history) = &context.deps.query_history {
        query_history.clear_name(&index_name).await?;
    }
    let recorded = name_index_uuid.to_string();
    context
        .record_job_change(|job| {
            let mut changed = job.clone();
            changed.name_index_uuid = Some(recorded.clone());
            changed
        })
        .await?;
    context.assert_still_driving()?;
    if !write_name_metadata(context, restorable, request, &constraints, name_index_uuid).await? {
        return Err(name_taken(&index_name));
    }
    Ok(())
}

pub(crate) async fn run_backup_restore(
    context: BackupDriverContext,
    request: RestoreRequest,
) -> ClusterResult<()> {
    let index_name = context.job_index_name()?;
    let manifest = &request.manifest;
    let restorable = read_restorable_config(&context, manifest).await?;
    let generation = format!("{HIDDEN_GENERATION_PREFIX}{}", generate_node_id()?);
    let name_index_uuid = generate_node_id()?;
    let (recorded, total) = (generation.clone(), manifest.partition_count as f64);
    context
        .record_job_change(|job| {
            let mut changed = job.clone();
            changed.generation = Some(recorded.clone());
            changed.partitions_total = total;
            changed
        })
        .await?;
    let named = restore_and_name(
        &context,
        &request,
        &restorable,
        &generation,
        &name_index_uuid,
    )
    .await;
    if let Err(error) = named {
        if let Err(dropped) =
            drop_unpublished_generation(context.coordinator(), &index_name, &generation).await
        {
            context.report(&dropped);
        }
        return Err(error);
    }
    publish_restored_name(&context, &generation, &name_index_uuid).await?;
    write_restored_history(&context, manifest, &index_name).await
}
