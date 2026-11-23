use std::time::Duration;

use narsil::{Value, decode_msgpack};

use super::constants::BACKUP_PUBLISH_RETRY_MS;
use super::driver_context::BackupDriverContext;
use super::query_history::write_restored_history;
use super::store::read_backup_manifest;
use crate::constants::{SYNONYM_SET_KEY_PREFIX, TEARDOWN_CAS_ATTEMPTS};
use crate::controller::{index_metadata, metadata_key};
use crate::coordinator::AllocationTable;
use crate::coordinator::etcd::EtcdCoordinator;
use crate::data::synonym_set::{SynonymSetRef, synonym_set_ref};
use crate::error::{ClusterError, ClusterResult, codes};

const FINAL_PUBLICATION_CODES: [&str; 3] = [
    codes::INDEX_ALREADY_EXISTS,
    codes::INDEX_NOT_FOUND,
    codes::NODE_NOT_CONTROLLER,
];
const POINTER_TABLE_VERSION: f64 = 1.0;

pub(crate) fn name_taken(index_name: &str) -> ClusterError {
    ClusterError::new(
        codes::INDEX_ALREADY_EXISTS,
        format!(
            "Index '{index_name}' already exists in the cluster, so the restore creates nothing"
        ),
    )
    .with_detail("indexName", Value::from(index_name))
}

pub(crate) async fn refuse_taken_name(
    coordinator: &EtcdCoordinator,
    index_name: &str,
) -> ClusterResult<()> {
    if index_metadata(coordinator, index_name).await?.is_some()
        || coordinator.schema(index_name).await?.is_some()
        || coordinator.allocation(index_name).await?.is_some()
    {
        return Err(name_taken(index_name));
    }
    Ok(())
}

async fn serves_generation(
    coordinator: &EtcdCoordinator,
    index_name: &str,
    generation: &str,
) -> ClusterResult<bool> {
    Ok(coordinator
        .allocation(index_name)
        .await?
        .and_then(|table| table.generation)
        .as_deref()
        == Some(generation))
}

fn stored_synonym_set_of(stored: &[u8]) -> Option<(String, SynonymSetRef)> {
    let Ok(Value::Object(record)) = decode_msgpack(stored) else {
        return None;
    };
    let index_uuid = record.get("indexUuid")?.as_str()?.to_string();
    let reference = record.get("settings")?.as_object()?.get("synonyms")?;
    synonym_set_ref(reference)
        .ok()
        .map(|reference| (index_uuid, reference))
}

async fn withdraw_generation_metadata(
    coordinator: &EtcdCoordinator,
    generation: &str,
) -> ClusterResult<()> {
    let key = metadata_key(generation);
    for _ in 0..TEARDOWN_CAS_ATTEMPTS {
        let Some(stored) = coordinator
            .get(&key)
            .await?
            .filter(|stored| !stored.is_empty())
        else {
            return Ok(());
        };
        if coordinator
            .compare_and_set(&key, Some(&stored), &[])
            .await?
        {
            if let Some((index_uuid, reference)) = stored_synonym_set_of(&stored) {
                for chunk in 0..reference.chunk_count {
                    coordinator
                        .delete(&format!(
                            "{SYNONYM_SET_KEY_PREFIX}{index_uuid}/{}/{chunk}",
                            reference.generation
                        ))
                        .await?;
                }
            }
            return Ok(());
        }
    }
    Err(ClusterError::new(
        codes::ALLOCATION_FAILED,
        format!("Withdrawing the metadata of '{generation}' lost every compare-and-set attempt"),
    )
    .with_detail("generation", Value::from(generation))
    .with_detail("attempts", Value::from(TEARDOWN_CAS_ATTEMPTS as u64)))
}

pub(crate) async fn drop_unpublished_generation(
    coordinator: &EtcdCoordinator,
    index_name: &str,
    generation: &str,
) -> ClusterResult<()> {
    if serves_generation(coordinator, index_name, generation).await? {
        return Ok(());
    }
    withdraw_generation_metadata(coordinator, generation).await?;
    if coordinator.schema(generation).await?.is_some() {
        coordinator.drop_schema(generation).await?;
    }
    Ok(())
}

async fn point_name_at_generation(
    context: &BackupDriverContext,
    index_name: &str,
    generation: &str,
    index_uuid: &str,
) -> ClusterResult<()> {
    let coordinator = context.coordinator();
    if let Some(current) = coordinator.allocation(index_name).await? {
        if current.generation.as_deref() != Some(generation) {
            return Err(name_taken(index_name));
        }
        return Ok(());
    }
    let metadata = index_metadata(coordinator, index_name).await?;
    let Some(metadata) = metadata.filter(|metadata| metadata.index_uuid == index_uuid) else {
        return Err(name_taken(index_name));
    };
    let pointer = AllocationTable {
        index_name: index_name.to_string(),
        version: POINTER_TABLE_VERSION,
        replication_factor: metadata.replication_factor,
        assignments: Vec::new(),
        generation: Some(generation.to_string()),
        index_uuid: Some(index_uuid.to_string()),
    };
    if coordinator
        .put_allocation_guarded(index_name, &pointer, None, context.node_id(), None)
        .await?
    {
        return Ok(());
    }
    if serves_generation(coordinator, index_name, generation).await? {
        return Ok(());
    }
    Err(ClusterError::new(
        codes::ALLOCATION_FAILED,
        format!(
            "The controller could not point index '{index_name}' at its restored partitions yet"
        ),
    )
    .with_detail("indexName", Value::from(index_name)))
}

async fn publish_schema(
    coordinator: &EtcdCoordinator,
    index_name: &str,
    generation: &str,
) -> ClusterResult<()> {
    if coordinator.schema(index_name).await?.is_some() {
        return Ok(());
    }
    let Some(schema) = coordinator.schema(generation).await? else {
        return Err(ClusterError::new(
            codes::INDEX_NOT_FOUND,
            format!("The restored partitions of '{index_name}' lost their schema"),
        )
        .with_detail("indexName", Value::from(index_name))
        .with_detail("generation", Value::from(generation)));
    };
    coordinator.put_schema(index_name, &schema).await
}

pub(crate) async fn publish_restored_name(
    context: &BackupDriverContext,
    generation: &str,
    index_uuid: &str,
) -> ClusterResult<()> {
    let index_name = context.job_index_name()?;
    loop {
        context.assert_still_driving()?;
        let published = async {
            point_name_at_generation(context, &index_name, generation, index_uuid).await?;
            publish_schema(context.coordinator(), &index_name, generation).await
        }
        .await;
        match published {
            Ok(()) => return Ok(()),
            Err(error) if FINAL_PUBLICATION_CODES.contains(&error.code()) => return Err(error),
            Err(error) => context.report(&error),
        }
        tokio::time::sleep(Duration::from_millis(BACKUP_PUBLISH_RETRY_MS)).await;
    }
}

fn interrupted(context: &BackupDriverContext) -> ClusterError {
    ClusterError::new(
        codes::ALLOCATION_FAILED,
        format!(
            "The controller that ran the restore of backup '{}' stopped before the index was ready, so the restore created no index",
            context.job.backup_name
        ),
    )
    .with_detail("backupName", Value::from(context.job.backup_name.as_str()))
    .with_detail("jobId", Value::from(context.job_id.as_str()))
}

pub(crate) async fn resume_restore(context: BackupDriverContext) -> ClusterResult<()> {
    let index_name = context.job_index_name()?;
    let Some(generation) = context.job.generation.clone() else {
        return Err(interrupted(&context));
    };
    let metadata = index_metadata(context.coordinator(), &index_name).await?;
    let name_index_uuid = context.job.name_index_uuid.clone();
    if let Some(index_uuid) = name_index_uuid.as_deref().filter(|uuid| {
        metadata
            .as_ref()
            .is_some_and(|metadata| metadata.index_uuid == *uuid)
    }) {
        publish_restored_name(&context, &generation, index_uuid).await?;
        let backup_name = context.job.backup_name.clone();
        let manifest = context
            .store
            .run(move |store| read_backup_manifest(store, &backup_name))
            .await?;
        return write_restored_history(&context, &manifest, &index_name).await;
    }
    drop_unpublished_generation(context.coordinator(), &index_name, &generation).await?;
    Err(interrupted(&context))
}
