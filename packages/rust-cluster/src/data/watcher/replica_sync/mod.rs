mod answer;
mod copy;

use std::sync::Arc;
use std::time::{Duration, Instant};

use narsil::Value;

use super::WatcherContext;
use super::state::PartitionKey;
use crate::constants::BOOTSTRAP_SYNC_DEADLINE_MS;
use crate::data::blocking::off_executor;
use crate::data::stored_index::{StoredIndex, stored_index};
use crate::error::{ClusterError, ClusterResult, codes};

const CODES_THAT_TRY_THE_NEXT_ADDRESS: [&str; 9] = [
    codes::SNAPSHOT_SYNC_TRANSPORT_FAILED,
    codes::SNAPSHOT_SYNC_TIMEOUT,
    codes::SNAPSHOT_SYNC_DECODE_FAILED,
    codes::SNAPSHOT_SYNC_FRAME_INVALID,
    codes::SNAPSHOT_SYNC_CHECKSUM_MISMATCH,
    codes::SNAPSHOT_SYNC_CHUNK_OUT_OF_ORDER,
    codes::SNAPSHOT_SYNC_CHUNK_OVERFLOW,
    codes::SNAPSHOT_SYNC_CHUNK_MISSING,
    codes::SNAPSHOT_SYNC_END_MISSING,
];

const PRIMARY_CODES_THAT_TRY_THE_NEXT_ADDRESS: [&str; 4] = [
    codes::SNAPSHOT_SYNC_ALLOCATION_UNAVAILABLE,
    codes::SNAPSHOT_SYNC_CAPACITY_EXHAUSTED,
    codes::SNAPSHOT_SYNC_SNAPSHOT_FAILED,
    codes::REPLICATION_SYNC_FAILED,
];

struct ReplicaSync<'a> {
    key: &'a PartitionKey,
    stored: StoredIndex,
    routed_uuid: Option<String>,
    partition_count: u32,
    deadline: Instant,
}

fn sync_error(code: &str, key: &PartitionKey, message: String) -> ClusterError {
    ClusterError::new(code, message)
        .with_detail("indexName", Value::String(key.0.clone()))
        .with_detail("partitionId", Value::from(key.1))
}

fn with_cause(error: ClusterError, cause: &ClusterError) -> ClusterError {
    error.with_detail("cause", Value::String(cause.message().to_string()))
}

fn tries_the_next_address(failure: &ClusterError) -> bool {
    if CODES_THAT_TRY_THE_NEXT_ADDRESS.contains(&failure.code()) {
        return true;
    }
    failure.code() == codes::SNAPSHOT_SYNC_PRIMARY_ERROR
        && matches!(
            failure.details().get("primaryCode"),
            Some(Value::String(code)) if PRIMARY_CODES_THAT_TRY_THE_NEXT_ADDRESS.contains(&code.as_str())
        )
}

impl WatcherContext {
    pub(super) async fn sync_replica(
        self: &Arc<Self>,
        key: &PartitionKey,
        primary_node_id: &str,
    ) -> ClusterResult<bool> {
        let index_name = key.0.as_str();
        if let Err(orphaned) = self.copies.refuse_orphaned(index_name) {
            self.report(&orphaned);
            return Ok(false);
        }
        if let Err(error) = self.drop_superseded_copy(index_name).await {
            self.report(&error);
            return Ok(false);
        }
        let deadline = Instant::now() + Duration::from_millis(BOOTSTRAP_SYNC_DEADLINE_MS);
        let stored = self.replica_config(key).await?;
        let (partition_count, routed_uuid) =
            self.live_partition_count(key, primary_node_id).await?;
        let sync = ReplicaSync {
            key,
            stored,
            routed_uuid,
            partition_count,
            deadline,
        };
        let mut attempted: Vec<String> = Vec::new();
        let mut last_failure = None;
        for target in self.node_targets(primary_node_id).await {
            if attempted.contains(&target) {
                continue;
            }
            attempted.push(target.clone());
            if Instant::now() >= deadline {
                return Err(sync_error(
                    codes::SNAPSHOT_SYNC_TIMEOUT,
                    key,
                    "bootstrap sync exceeded deadline while iterating live targets".to_string(),
                ));
            }
            let failure = match self.sync_from(&sync, &target).await {
                Ok(sync_session) => match self
                    .report_synced_position(&sync, &target, sync_session)
                    .await
                {
                    Ok(()) => return self.hold_synced_partition(key).await,
                    Err(failure) => failure,
                },
                Err(failure) => failure,
            };
            let failure = failure.with_detail("target", Value::String(target));
            if !tries_the_next_address(&failure) {
                return Err(failure);
            }
            last_failure = Some(failure);
        }
        Err(last_failure.unwrap_or_else(|| {
            sync_error(
                codes::SNAPSHOT_SYNC_NO_TARGETS,
                key,
                format!("no transport targets resolved for primary '{primary_node_id}'"),
            )
        }))
    }

    async fn replica_config(&self, key: &PartitionKey) -> ClusterResult<StoredIndex> {
        let index_name = key.0.as_str();
        let schema = match self.coordinator.schema(index_name).await {
            Ok(Some(schema)) => schema,
            Ok(None) => {
                return Err(sync_error(
                    codes::SNAPSHOT_SYNC_SCHEMA_UNAVAILABLE,
                    key,
                    format!("coordinator has no schema for index '{index_name}'"),
                ));
            }
            Err(error) => {
                let failure = sync_error(
                    codes::SNAPSHOT_SYNC_SCHEMA_UNAVAILABLE,
                    key,
                    format!(
                        "reading the schema of index '{index_name}' failed: {}",
                        error.message()
                    ),
                );
                return Err(with_cause(failure, &error));
            }
        };
        stored_index(&self.coordinator, index_name, &schema)
            .await?
            .ok_or_else(|| {
                sync_error(
                    codes::SNAPSHOT_SYNC_SCHEMA_UNAVAILABLE,
                    key,
                    format!("coordinator has no metadata for index '{index_name}'"),
                )
            })
    }

    async fn live_partition_count(
        &self,
        key: &PartitionKey,
        primary_node_id: &str,
    ) -> ClusterResult<(u32, Option<String>)> {
        let (index_name, partition_id) = (key.0.as_str(), key.1);
        let table = self.live_table(index_name).await.map_err(|error| {
            let failure = sync_error(
                codes::SNAPSHOT_SYNC_ALLOCATION_UNAVAILABLE,
                key,
                format!(
                    "reading the allocation of index '{index_name}' failed: {}",
                    error.message()
                ),
            );
            with_cause(failure, &error)
        })?;
        let Some(table) = table else {
            return Err(sync_error(
                codes::SNAPSHOT_SYNC_ALLOCATION_UNAVAILABLE,
                key,
                format!("coordinator has no allocation for index '{index_name}'"),
            ));
        };
        let Some(assignment) = table.assignments.get(f64::from(partition_id)) else {
            return Err(sync_error(
                codes::SNAPSHOT_SYNC_NOT_ASSIGNED,
                key,
                format!(
                    "No assignment exists for partition {partition_id} of index '{index_name}'"
                ),
            ));
        };
        if !assignment.is_primary(primary_node_id) {
            let current = assignment
                .primary
                .as_deref()
                .map_or(Value::Null, Value::from);
            return Err(sync_error(
                codes::SNAPSHOT_SYNC_NOT_ASSIGNED,
                key,
                format!(
                    "Partition {partition_id} of index '{index_name}' is no longer primary on '{primary_node_id}'"
                ),
            )
            .with_detail("currentPrimary", current));
        }
        let partition_count = u32::try_from(table.assignments.len()).unwrap_or(u32::MAX);
        Ok((partition_count, table.index_uuid.clone()))
    }

    async fn hold_synced_partition(&self, key: &PartitionKey) -> ClusterResult<bool> {
        let (copies, name, partition_id) = (Arc::clone(&self.copies), key.0.clone(), key.1);
        off_executor(move || copies.hold_partition(&name, partition_id)).await??;
        Ok(true)
    }
}
