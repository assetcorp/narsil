use std::sync::Arc;

use narsil::Value;

use super::WatcherContext;
use super::state::PartitionKey;
use crate::controller::index_metadata;
use crate::data::blocking::off_executor;
use crate::error::{ClusterError, ClusterResult, codes};

fn drop_failure(index_name: &str, partition_id: Option<u32>, cause: &ClusterError) -> ClusterError {
    let after = if partition_id.is_some() {
        "partition removal"
    } else {
        "its allocation was torn down"
    };
    let mut failure = ClusterError::new(
        codes::SNAPSHOT_SYNC_RESTORE_FAILED,
        format!(
            "failed to drop local index '{index_name}' after {after}: {}",
            cause.message()
        ),
    )
    .with_detail("indexName", Value::String(index_name.to_string()))
    .with_detail("cause", Value::String(cause.message().to_string()));
    if let Some(partition_id) = partition_id {
        failure = failure.with_detail("partitionId", Value::from(partition_id));
    }
    failure
}

impl WatcherContext {
    async fn local_uuid(self: &Arc<Self>, index_name: &str) -> ClusterResult<Option<String>> {
        let (copies, name) = (Arc::clone(&self.copies), index_name.to_string());
        off_executor(move || copies.local_uuid(&name)).await?
    }

    async fn drop_copy_of(
        self: &Arc<Self>,
        index_name: &str,
        index_uuid: &str,
    ) -> ClusterResult<()> {
        let (copies, name, uuid) = (
            Arc::clone(&self.copies),
            index_name.to_string(),
            index_uuid.to_string(),
        );
        off_executor(move || copies.drop_copy_of(&name, &uuid)).await?
    }

    pub(super) async fn hold_partition(self: &Arc<Self>, key: PartitionKey) {
        if self.copies.is_orphaned(&key.0) {
            return;
        }
        let copies = Arc::clone(&self.copies);
        let held = off_executor(move || copies.hold_partition(&key.0, key.1)).await;
        if let Err(error) = held.and_then(|held| held) {
            self.report(&error);
        }
    }

    async fn replaced_removed_copy(&self, index_name: &str, removed_uuid: &str) -> bool {
        match index_metadata(&self.coordinator, index_name).await {
            Ok(None) => true,
            Ok(Some(metadata)) => metadata.index_uuid != removed_uuid,
            Err(_) => false,
        }
    }

    async fn holds_other_partitions(&self, index_name: &str, removed: u32) -> bool {
        let table = match self.live_table(index_name).await {
            Ok(Some(table)) => table,
            Ok(None) => return false,
            Err(_) => return true,
        };
        table.assignments.iter().any(|(partition_id, assignment)| {
            partition_id != f64::from(removed)
                && (assignment.is_primary(&self.node_id)
                    || assignment.holds_replica(&self.node_id)
                    || assignment.last_holders_of().contains(&self.node_id))
        })
    }

    async fn clean_removed_partition(self: &Arc<Self>, key: &PartitionKey) -> ClusterResult<()> {
        let Some(removed_uuid) = self.local_uuid(&key.0).await? else {
            return Ok(());
        };
        let copies = Arc::clone(&self.copies);
        let (name, partition_id) = (key.0.clone(), key.1);
        off_executor(move || copies.forget_partition(&name, partition_id)).await??;
        let replaced = self.replaced_removed_copy(&key.0, &removed_uuid).await;
        if !replaced && self.holds_other_partitions(&key.0, key.1).await {
            return Ok(());
        }
        self.drop_copy_of(&key.0, &removed_uuid).await
    }

    pub(super) async fn remove_partition(self: &Arc<Self>, key: PartitionKey) {
        if self.copies.is_orphaned(&key.0) {
            return;
        }
        if let Err(error) = self.clean_removed_partition(&key).await {
            self.report(&drop_failure(&key.0, Some(key.1), &error));
        }
    }

    async fn release(self: &Arc<Self>, index_name: &str) -> ClusterResult<()> {
        let Some(removed_uuid) = self.local_uuid(index_name).await? else {
            return Ok(());
        };
        if self
            .live_table(index_name)
            .await?
            .is_some_and(|table| !table.assignments.is_empty())
        {
            return Ok(());
        }
        self.drop_copy_of(index_name, &removed_uuid).await
    }

    pub(super) async fn release_torn_down(self: &Arc<Self>, index_name: String) {
        if self.copies.is_orphaned(&index_name) {
            return;
        }
        if let Err(error) = self.release(&index_name).await {
            self.report(&drop_failure(&index_name, None, &error));
        }
    }
}
