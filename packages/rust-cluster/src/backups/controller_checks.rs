use narsil::Value;
use narsil::replication::BackupManifest;

use super::constants::BACKUP_SPEC_VERSION;
use super::restore_publish::refuse_taken_name;
use super::store::{
    BackupStore, backup_name_taken, backup_not_found, claim_backup_store, cluster_uuid_of,
    holds_manifest, read_backup_manifest,
};
use crate::constants::HIDDEN_GENERATION_PREFIX;
use crate::controller::{index_metadata, rebalance_generations, validate_index_name};
use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::version::reaches_version;

async fn require_backup_ready(coordinator: &EtcdCoordinator) -> ClusterResult<()> {
    let older: Vec<String> = coordinator
        .list_nodes()
        .await?
        .into_iter()
        .filter(|node| !reaches_version(&node.version, BACKUP_SPEC_VERSION))
        .map(|node| node.node_id)
        .collect();
    if older.is_empty() {
        return Ok(());
    }
    Err(ClusterError::new(
        codes::BACKUP_NOT_READY,
        format!(
            "The cluster has nodes below specification {BACKUP_SPEC_VERSION}, so it takes no backup call until they are upgraded: {}",
            older.join(", ")
        ),
    )
    .with_detail(
        "nodeIds",
        Value::Array(older.into_iter().map(Value::String).collect()),
    ))
}

pub(crate) fn refuse_hidden_generation(index_name: &str) -> ClusterResult<()> {
    if !index_name.starts_with(HIDDEN_GENERATION_PREFIX) {
        return Ok(());
    }
    Err(ClusterError::new(
        codes::CONFIG_INVALID,
        format!(
            "Index names that start with '{HIDDEN_GENERATION_PREFIX}' are reserved for partition count changes"
        ),
    )
    .with_detail("indexName", Value::from(index_name)))
}

pub(crate) fn require_restorable_index_name(index_name: &str) -> ClusterResult<String> {
    refuse_hidden_generation(index_name)?;
    validate_index_name(index_name)?;
    Ok(index_name.to_string())
}

pub(crate) async fn serving_name_of(
    coordinator: &EtcdCoordinator,
    index_name: &str,
) -> ClusterResult<String> {
    refuse_hidden_generation(index_name)?;
    let table = coordinator.allocation(index_name).await?;
    Ok(table
        .and_then(|table| table.generation)
        .unwrap_or_else(|| index_name.to_string()))
}

async fn claim(coordinator: &EtcdCoordinator, store: &BackupStore) -> ClusterResult<()> {
    let cluster_uuid = cluster_uuid_of(coordinator).await?;
    store
        .run(move |store| claim_backup_store(store, &cluster_uuid))
        .await
}

async fn store_holds_manifest(store: &BackupStore, backup_name: &str) -> ClusterResult<bool> {
    let name = backup_name.to_string();
    store.run(move |store| holds_manifest(store, &name)).await
}

pub(crate) async fn admit_backup(
    coordinator: &EtcdCoordinator,
    store: &BackupStore,
    backup_name: &str,
    index_name: &str,
) -> ClusterResult<()> {
    require_backup_ready(coordinator).await?;
    let generation = serving_name_of(coordinator, index_name).await?;
    if index_metadata(coordinator, &generation).await?.is_none() {
        return Err(ClusterError::new(
            codes::INDEX_NOT_FOUND,
            format!("Index '{index_name}' does not exist in the cluster"),
        )
        .with_detail("indexName", Value::from(index_name)));
    }
    if store_holds_manifest(store, backup_name).await? {
        return Err(backup_name_taken(backup_name));
    }
    if rebalance_generations(coordinator, index_name)
        .await?
        .is_some()
    {
        return Err(ClusterError::new(
            codes::PARTITION_REBALANCING_BACKPRESSURE,
            format!(
                "The partition count of index '{index_name}' is changing, so a backup can start once the change ends"
            ),
        )
        .with_detail("indexName", Value::from(index_name)));
    }
    claim(coordinator, store).await
}

pub(crate) async fn admit_restore(
    coordinator: &EtcdCoordinator,
    store: &BackupStore,
    backup_name: &str,
    index_name: &str,
) -> ClusterResult<BackupManifest> {
    require_backup_ready(coordinator).await?;
    require_restorable_index_name(index_name)?;
    let name = backup_name.to_string();
    let manifest = store
        .run(move |store| read_backup_manifest(store, &name))
        .await?;
    refuse_taken_name(coordinator, index_name).await?;
    Ok(manifest)
}

pub(crate) async fn admit_deletion(
    coordinator: &EtcdCoordinator,
    store: &BackupStore,
    backup_name: &str,
) -> ClusterResult<()> {
    require_backup_ready(coordinator).await?;
    if !store_holds_manifest(store, backup_name).await? {
        return Err(backup_not_found(store, backup_name));
    }
    claim(coordinator, store).await
}
