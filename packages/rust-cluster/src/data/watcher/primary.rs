use std::sync::Arc;

use narsil::Value;
use narsil::replication::CopyPosition;

use super::WatcherContext;
use super::state::PartitionKey;
use crate::allocator::{Assignment, INITIALISING};
use crate::data::blocking::off_executor;
use crate::data::schema_check::schema_differences;
use crate::data::stored_index::stored_index;
use crate::error::{ClusterError, ClusterResult, codes};

fn promoted_from_last_holders(assignment: Option<&Assignment>, node_id: &str) -> bool {
    assignment.is_some_and(|assignment| {
        assignment.state == INITIALISING
            && assignment.is_primary(node_id)
            && !assignment.last_holders_of().is_empty()
    })
}

fn schema_mismatch(index_name: &str, node_id: &str, differences: Vec<Value>) -> ClusterError {
    ClusterError::new(
        codes::SNAPSHOT_SYNC_RESTORE_FAILED,
        format!("restored snapshot schema disagrees with coordinator schema for '{index_name}'"),
    )
    .with_detail("indexName", Value::String(index_name.to_string()))
    .with_detail("primaryNodeId", Value::String(node_id.to_string()))
    .with_detail("reason", Value::String("schema mismatch".to_string()))
    .with_detail("differences", Value::Array(differences))
}

fn schema_unreadable(index_name: &str, node_id: &str, cause: &str) -> ClusterError {
    ClusterError::new(
        codes::SNAPSHOT_SYNC_RESTORE_FAILED,
        format!("failed to read restored schema for '{index_name}': {cause}"),
    )
    .with_detail("indexName", Value::String(index_name.to_string()))
    .with_detail("primaryNodeId", Value::String(node_id.to_string()))
    .with_detail("reason", Value::String("schema lookup failed".to_string()))
    .with_detail("cause", Value::String(cause.to_string()))
}

impl WatcherContext {
    pub(super) async fn drop_superseded_copy(
        self: &Arc<Self>,
        index_name: &str,
    ) -> ClusterResult<()> {
        let (copies, name) = (Arc::clone(&self.copies), index_name.to_string());
        let Some(local_uuid) = off_executor(move || copies.local_uuid(&name)).await?? else {
            return Ok(());
        };
        let Some(metadata) =
            crate::controller::index_metadata(&self.coordinator, index_name).await?
        else {
            return Ok(());
        };
        if metadata.index_uuid == local_uuid {
            return Ok(());
        }
        let (copies, name) = (Arc::clone(&self.copies), index_name.to_string());
        off_executor(move || copies.drop_copy_of(&name, &local_uuid)).await??;
        self.writes.forget_index(index_name);
        Ok(())
    }

    pub(super) async fn checked_schema(
        self: &Arc<Self>,
        index_name: &str,
        expected: &Value,
    ) -> Option<ClusterError> {
        let (copies, name) = (Arc::clone(&self.copies), index_name.to_string());
        let held = match off_executor(move || copies.schema_of(&name)).await {
            Ok(Ok(held)) => held,
            Ok(Err(error)) => {
                return Some(schema_unreadable(
                    index_name,
                    &self.node_id,
                    error.message(),
                ));
            }
            Err(error) => return Some(error),
        };
        let differences = schema_differences(expected, &held);
        (!differences.is_empty()).then(|| schema_mismatch(index_name, &self.node_id, differences))
    }

    pub(super) async fn prepare_primary(
        self: &Arc<Self>,
        key: &PartitionKey,
    ) -> ClusterResult<bool> {
        let (index_name, partition_id) = (key.0.as_str(), key.1);
        if let Err(orphaned) = self.copies.refuse_orphaned(index_name) {
            self.report(&orphaned);
            return Ok(false);
        }
        if let Err(error) = self.drop_superseded_copy(index_name).await {
            self.report(&error);
            return Ok(false);
        }
        let Some(schema) = self.coordinator.schema(index_name).await? else {
            return Ok(false);
        };
        let stored = match stored_index(&self.coordinator, index_name, &schema).await {
            Ok(Some(stored)) => stored,
            Ok(None) => return Ok(false),
            Err(error) => {
                self.report(&error);
                return Ok(false);
            }
        };
        let Some(table) = self.live_table(index_name).await? else {
            return Ok(false);
        };
        let Ok(partition_count) = u32::try_from(table.assignments.len()) else {
            return Ok(false);
        };
        if partition_count == 0 {
            return Ok(false);
        }
        let assignment = table.assignments.get(f64::from(partition_id)).cloned();
        if promoted_from_last_holders(assignment.as_ref(), &self.node_id)
            && !self
                .can_list_copy(index_name, &stored.index_uuid, partition_id)
                .await?
        {
            self.writes.fail_missing_copy(index_name, partition_id);
            return Ok(false);
        }
        let copies = Arc::clone(&self.copies);
        let name = index_name.to_string();
        let held = off_executor(move || copies.holds_index(&name)).await?;
        if held {
            if let Some(error) = self.checked_schema(index_name, &stored.config.schema).await {
                self.report(&error);
                return Ok(false);
            }
        } else {
            let (copies, name, uuid) = (
                Arc::clone(&self.copies),
                index_name.to_string(),
                stored.index_uuid.clone(),
            );
            let config = stored.config;
            if let Err(error) =
                off_executor(move || copies.create_copy(&name, config, &uuid, partition_count))
                    .await?
            {
                self.report(&error);
                return Ok(false);
            }
            self.writes.forget_index(index_name);
        }
        let floor = assignment.as_ref().map(|assignment| CopyPosition {
            seq_no: assignment.commit_point as u64,
            primary_term: assignment.primary_term as u64,
        });
        let (copies, name, uuid) = (
            Arc::clone(&self.copies),
            index_name.to_string(),
            stored.index_uuid,
        );
        let readied =
            off_executor(move || copies.ready_primary(&name, &uuid, partition_id, floor)).await?;
        if let Err(error) = readied {
            self.report(&error);
            return Ok(false);
        }
        Ok(true)
    }

    pub(super) async fn can_list_copy(
        self: &Arc<Self>,
        index_name: &str,
        index_uuid: &str,
        partition_id: u32,
    ) -> ClusterResult<bool> {
        let (copies, name) = (Arc::clone(&self.copies), index_name.to_string());
        let stored = off_executor(move || copies.stored_partitions(&name)).await??;
        Ok(stored.index_uuid.as_deref() == Some(index_uuid)
            && stored.partition_ids.contains(&partition_id))
    }
}
