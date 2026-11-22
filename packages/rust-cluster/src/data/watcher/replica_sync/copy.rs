use std::sync::Arc;

use narsil::Value;

use super::{ReplicaSync, sync_error, with_cause};
use crate::data::blocking::off_executor;
use crate::data::watcher::WatcherContext;
use crate::error::{ClusterResult, codes};

impl WatcherContext {
    pub(super) async fn ensure_replica_copy(
        self: &Arc<Self>,
        sync: &ReplicaSync<'_>,
    ) -> ClusterResult<()> {
        let key = sync.key;
        let (copies, name) = (Arc::clone(&self.copies), key.0.clone());
        if !off_executor(move || copies.holds_index(&name)).await? {
            let (copies, name) = (Arc::clone(&self.copies), key.0.clone());
            let (config, uuid, count) = (
                sync.stored.config.clone(),
                sync.stored.index_uuid.clone(),
                sync.partition_count,
            );
            let created =
                off_executor(move || copies.create_copy(&name, config, &uuid, count)).await?;
            if let Err(error) = created {
                let failure = sync_error(
                    codes::SNAPSHOT_SYNC_RESTORE_FAILED,
                    key,
                    format!("creating the local copy failed: {}", error.message()),
                );
                return Err(with_cause(failure, &error));
            }
            self.writes.forget_index(&key.0);
        }
        self.check_replica_copy(sync).await
    }

    async fn check_replica_copy(self: &Arc<Self>, sync: &ReplicaSync<'_>) -> ClusterResult<()> {
        let key = sync.key;
        if let Some(error) = self
            .checked_schema(&key.0, &sync.stored.config.schema)
            .await
        {
            return Err(error);
        }
        let (copies, name) = (Arc::clone(&self.copies), key.0.clone());
        let counted = off_executor(move || {
            copies
                .engine
                .get_stats(&name)
                .map(|stats| stats.partition_count)
        })
        .await?;
        let local = counted.map_err(|error| {
            sync_error(
                codes::SNAPSHOT_SYNC_RESTORE_FAILED,
                key,
                format!(
                    "failed to read local partition count for '{}': {error}",
                    key.0
                ),
            )
        })?;
        if local == sync.partition_count as usize {
            return Ok(());
        }
        Err(sync_error(
            codes::SNAPSHOT_SYNC_RESTORE_FAILED,
            key,
            format!(
                "local partition count {local} disagrees with coordinator partition count {}",
                sync.partition_count
            ),
        )
        .with_detail("localPartitionCount", Value::from(local as u64))
        .with_detail("partitionCount", Value::from(sync.partition_count)))
    }
}
