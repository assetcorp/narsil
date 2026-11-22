use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use narsil::{ErrorCode, Value};

use super::PrimaryWrites;
use super::scope::Scope;
use crate::allocator::{Assignment, Table, UNASSIGNED};
use crate::constants::{CONTROLLER_LEASE_KEY, COPY_FAILURE_ATTEMPTS, COPY_FAILURE_RETRY_DELAY_MS};
use crate::controller::{index_metadata, lock};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::message_types;
use crate::payload::ack::{encode_primary_resign, insync_confirmed};
use crate::payload::invalid_entry;

#[derive(Default)]
pub(super) struct CopyFailures {
    failed: Mutex<HashMap<String, HashMap<u32, Option<bool>>>>,
}

impl CopyFailures {
    pub(super) fn is_failed(&self, index_name: &str, partition_id: u32) -> bool {
        lock(&self.failed)
            .get(index_name)
            .is_some_and(|partitions| partitions.contains_key(&partition_id))
    }

    pub(super) fn is_unlisted(&self, index_name: &str, partition_id: u32) -> bool {
        lock(&self.failed)
            .get(index_name)
            .and_then(|partitions| partitions.get(&partition_id))
            .is_some_and(|reloaded| *reloaded != Some(true))
    }

    fn claim(&self, index_name: &str, partition_id: u32) -> bool {
        let mut failed = lock(&self.failed);
        let partitions = failed.entry(index_name.to_string()).or_default();
        if partitions.contains_key(&partition_id) {
            return false;
        }
        partitions.insert(partition_id, None);
        true
    }

    fn note_reloaded(&self, index_name: &str, partition_id: u32, reloaded: bool) {
        if let Some(slot) = lock(&self.failed)
            .get_mut(index_name)
            .and_then(|partitions| partitions.get_mut(&partition_id))
        {
            *slot = Some(reloaded);
        }
    }

    fn release(&self, index_name: &str, partition_id: u32) {
        let mut failed = lock(&self.failed);
        if let Some(partitions) = failed.get_mut(index_name) {
            partitions.remove(&partition_id);
            if partitions.is_empty() {
                failed.remove(index_name);
            }
        }
    }
}

enum Step {
    Reset,
    Kept,
    Retry,
}

#[derive(Default)]
struct Round {
    reloaded: Option<bool>,
    resigned_term: Option<u64>,
}

fn holds_other_in_sync_copy(assignment: &Assignment, node_id: &str) -> bool {
    assignment
        .replicas
        .iter()
        .any(|replica| replica != node_id && assignment.holds_in_sync(replica))
}

impl PrimaryWrites {
    pub(super) fn record_copy_failure(self: &Arc<Self>, index_name: &str, partition_id: u32) {
        if !self.failures.claim(index_name, partition_id) {
            return;
        }
        let writes = Arc::clone(self);
        let index_name = index_name.to_string();
        tokio::spawn(async move {
            if writes.recover(&index_name, partition_id).await {
                writes.failures.release(&index_name, partition_id);
            }
        });
    }

    pub(crate) fn copy_unlisted(&self, index_name: &str, partition_id: u32) -> bool {
        self.failures.is_unlisted(index_name, partition_id)
    }

    async fn recover(&self, index_name: &str, partition_id: u32) -> bool {
        let mut round = Round::default();
        let mut last_error = None;
        for attempt in 0..COPY_FAILURE_ATTEMPTS {
            if self.is_stopping() {
                return false;
            }
            if attempt > 0 {
                tokio::time::sleep(Duration::from_millis(COPY_FAILURE_RETRY_DELAY_MS)).await;
            }
            let step = match self.view.read_live(index_name).await {
                Ok(table) => {
                    self.step_for(&mut round, table, index_name, partition_id)
                        .await
                }
                Err(error) => Err(error),
            };
            match step {
                Ok(Step::Reset) => return true,
                Ok(Step::Kept) => return false,
                Ok(Step::Retry) => {}
                Err(error) => last_error = Some(error),
            }
        }
        let cause = last_error.map_or_else(
            || "every attempt found the copy still in service".to_string(),
            |error| error.message().to_string(),
        );
        self.report(
            &ClusterError::new(
                codes::REPLICATION_INSYNC_REMOVAL_FAILED,
                format!(
                    "Partition {partition_id} of index '{index_name}' keeps a failed copy, because the controller never took it out of service: {cause}"
                ),
            )
            .with_detail("indexName", Value::from(index_name))
            .with_detail("partitionId", Value::from(partition_id))
            .with_detail("nodeId", Value::from(self.node_id.as_str()))
            .with_detail("cause", Value::from(cause.as_str())),
        );
        false
    }

    async fn step_for(
        &self,
        round: &mut Round,
        table: Option<Table>,
        index_name: &str,
        partition_id: u32,
    ) -> ClusterResult<Step> {
        let assignment = table
            .as_ref()
            .and_then(|table| table.assignments.get(f64::from(partition_id)))
            .cloned();
        let Some(assignment) = assignment else {
            self.empty_failed_copy(index_name, partition_id).await?;
            return Ok(Step::Reset);
        };
        if assignment.state == UNASSIGNED {
            if assignment.last_holders_of().contains(&self.node_id) {
                let reloaded = self.reload_once(round, index_name, partition_id).await;
                return Ok(if reloaded { Step::Reset } else { Step::Kept });
            }
            self.empty_failed_copy(index_name, partition_id).await?;
            return Ok(Step::Reset);
        }
        let primary_term = assignment.primary_term as u64;
        if assignment.is_primary(&self.node_id) {
            let resigned = round
                .resigned_term
                .is_some_and(|resigned| primary_term > resigned);
            if resigned && round.reloaded == Some(true) {
                return Ok(Step::Reset);
            }
            if !holds_other_in_sync_copy(&assignment, &self.node_id) {
                self.reload_once(round, index_name, partition_id).await;
            }
            self.resign(index_name, partition_id, primary_term).await?;
            round.resigned_term = Some(primary_term);
            return Ok(Step::Retry);
        }
        if assignment.holds_in_sync(&self.node_id) {
            self.remove_self(index_name, partition_id, assignment)
                .await?;
            return Ok(Step::Retry);
        }
        self.empty_failed_copy(index_name, partition_id).await?;
        Ok(Step::Reset)
    }

    async fn empty_failed_copy(&self, index_name: &str, partition_id: u32) -> ClusterResult<()> {
        let partition = self.partitions.of(index_name, partition_id);
        let _turn = partition.turn().await;
        let name = index_name.to_string();
        self.on_copies(move |copies| copies.empty_partition(&name, partition_id))
            .await?;
        lock(&partition.log).clear();
        Ok(())
    }

    async fn reload_once(&self, round: &mut Round, index_name: &str, partition_id: u32) -> bool {
        if let Some(reloaded) = round.reloaded {
            return reloaded;
        }
        let partition = self.partitions.of(index_name, partition_id);
        let turn = partition.turn().await;
        let name = index_name.to_string();
        let reloaded = self
            .on_copies(move |copies| copies.reload_partition(&name, partition_id))
            .await;
        lock(&partition.log).clear();
        drop(turn);
        if let Err(error) = &reloaded {
            self.report(
                &ClusterError::new(
                    ErrorCode::PERSISTENCE_LOAD_FAILED.as_str(),
                    format!(
                        "Partition {partition_id} of index '{index_name}' failed to reload from this node's checkpoint and log, so the node leaves it out of the partitions it reports holding: {}",
                        error.message()
                    ),
                )
                .with_detail("indexName", Value::from(index_name))
                .with_detail("partitionId", Value::from(partition_id))
                .with_detail("nodeId", Value::from(self.node_id.as_str()))
                .with_detail("cause", Value::from(error.message())),
            );
        }
        let reloaded = reloaded.is_ok();
        round.reloaded = Some(reloaded);
        self.failures
            .note_reloaded(index_name, partition_id, reloaded);
        reloaded
    }

    async fn resign(
        &self,
        index_name: &str,
        partition_id: u32,
        primary_term: u64,
    ) -> ClusterResult<()> {
        let Some(controller) = self.coordinator.lease_holder(CONTROLLER_LEASE_KEY).await? else {
            return Ok(());
        };
        let Some(metadata) = index_metadata(&self.coordinator, index_name).await? else {
            return Ok(());
        };
        let payload =
            encode_primary_resign(index_name, &metadata.index_uuid, partition_id, primary_term);
        let message = self.message(message_types::REPLICATION_PRIMARY_RESIGN, payload)?;
        let answer = self.send_to_node(&controller, &message).await.map_err(|error| {
            ClusterError::new(
                error.code(),
                format!(
                    "Controller '{controller}' did not answer the resignation of partition {partition_id} of index '{index_name}'"
                ),
            )
            .with_detail("indexName", Value::from(index_name))
            .with_detail("partitionId", Value::from(partition_id))
            .with_detail("controllerNodeId", Value::from(controller.as_str()))
        })?;
        if let Some(failure) = answer.failure() {
            return Err(failure);
        }
        if insync_confirmed(&answer.payload).is_none() {
            return Err(invalid_entry(
                "InsyncConfirmPayload",
                "it needs a string indexName, a numeric partitionId, and a boolean accepted",
            ));
        }
        Ok(())
    }

    async fn remove_self(
        &self,
        index_name: &str,
        partition_id: u32,
        assignment: Assignment,
    ) -> ClusterResult<()> {
        let Some(controller) = self.coordinator.lease_holder(CONTROLLER_LEASE_KEY).await? else {
            return Ok(());
        };
        let scope = Scope {
            index_name: index_name.to_string(),
            partition_id,
            primary_term: assignment.primary_term as u64,
            assignment,
            index_uuid: None,
        };
        self.remove_replica(&scope, &self.node_id, &controller)
            .await
    }
}
