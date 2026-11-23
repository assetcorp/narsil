use std::sync::Arc;
use std::time::Instant;

use narsil::Value;
use narsil::replication::CopyPosition;

use crate::data::snapshot_spool::SpooledSnapshot;

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

    pub(super) async fn restore_snapshot(
        self: &Arc<Self>,
        sync: &ReplicaSync<'_>,
        target: &str,
        position: CopyPosition,
        archive: SpooledSnapshot,
    ) -> ClusterResult<()> {
        let key = sync.key;
        let remaining = sync.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(sync_error(
                codes::SNAPSHOT_SYNC_TIMEOUT,
                key,
                "bootstrap sync exceeded deadline before partition restore".to_string(),
            )
            .with_detail("primaryNodeId", Value::from(target)));
        }
        let restoring = self
            .writes
            .restore_snapshot(&key.0, key.1, position, archive);
        let restored = match tokio::time::timeout(remaining, restoring).await {
            Ok(restored) => restored,
            Err(_) => {
                return Err(sync_error(
                    codes::SNAPSHOT_SYNC_TIMEOUT,
                    key,
                    "bootstrap sync exceeded deadline during partition-restore".to_string(),
                ));
            }
        };
        if let Err(error) = restored {
            let failure = sync_error(
                codes::SNAPSHOT_SYNC_RESTORE_FAILED,
                key,
                format!("partition restore failed: {}", error.message()),
            )
            .with_detail("primaryNodeId", Value::from(target));
            return Err(with_cause(failure, &error));
        }
        match self
            .checked_schema(&key.0, &sync.stored.config.schema)
            .await
        {
            Some(error) => Err(error),
            None => Ok(()),
        }
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
