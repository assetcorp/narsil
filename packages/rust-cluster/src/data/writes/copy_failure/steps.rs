use narsil::{ErrorCode, Value};

use crate::allocator::{Assignment, INITIALISING, Table, UNASSIGNED};
use crate::constants::CONTROLLER_LEASE_KEY;
use crate::controller::{index_metadata, lock};
use crate::data::writes::PrimaryWrites;
use crate::data::writes::scope::Scope;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::message_types;
use crate::payload::ack::{encode_primary_resign, insync_confirmed};
use crate::payload::invalid_entry;

pub(super) enum Step {
    Reset,
    Kept,
    Retry,
}

pub(super) struct Round {
    claim: u64,
    index_uuid: Option<String>,
    uuid_recorded: bool,
    missing: bool,
    reloaded: Option<bool>,
    resigned_term: Option<u64>,
    removed: bool,
}

impl Round {
    pub(super) fn new(claim: u64) -> Round {
        Round {
            claim,
            index_uuid: None,
            uuid_recorded: false,
            missing: false,
            reloaded: None,
            resigned_term: None,
            removed: false,
        }
    }
}

fn holds_other_in_sync_copy(assignment: &Assignment, node_id: &str) -> bool {
    assignment
        .replicas
        .iter()
        .any(|replica| replica != node_id && assignment.holds_in_sync(replica))
}

impl PrimaryWrites {
    pub(super) async fn step_for(
        &self,
        round: &mut Round,
        table: Option<Table>,
        index_name: &str,
        partition_id: u32,
    ) -> ClusterResult<Step> {
        self.record_index_uuid(round, index_name).await?;
        round.missing = self.failures.is_missing(index_name, partition_id);
        let assignment = table
            .as_ref()
            .and_then(|table| table.assignments.get(f64::from(partition_id)))
            .cloned();
        let Some(assignment) = assignment else {
            self.empty_failed_copy(round, index_name, partition_id)
                .await?;
            return Ok(Step::Reset);
        };
        if round.missing
            && assignment.state == INITIALISING
            && assignment.last_holders_of().is_empty()
        {
            return Ok(Step::Reset);
        }
        if assignment.state == UNASSIGNED {
            if assignment.last_holders_of().contains(&self.node_id) {
                let reloaded = self.reload_once(round, index_name, partition_id).await;
                return Ok(if reloaded { Step::Reset } else { Step::Kept });
            }
            self.empty_failed_copy(round, index_name, partition_id)
                .await?;
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
            if self
                .remove_self(index_name, partition_id, assignment)
                .await?
            {
                round.removed = true;
            }
            return Ok(Step::Retry);
        }
        if assignment.holds_replica(&self.node_id) && !round.removed {
            if !self
                .remove_self(index_name, partition_id, assignment)
                .await?
            {
                return Ok(Step::Retry);
            }
            round.removed = true;
        }
        self.empty_failed_copy(round, index_name, partition_id)
            .await?;
        Ok(Step::Reset)
    }

    async fn record_index_uuid(&self, round: &mut Round, index_name: &str) -> ClusterResult<()> {
        if round.uuid_recorded {
            return Ok(());
        }
        let name = index_name.to_string();
        round.index_uuid = self
            .on_copies(move |copies| copies.local_uuid(&name))
            .await?;
        round.uuid_recorded = true;
        Ok(())
    }

    async fn empty_failed_copy(
        &self,
        round: &Round,
        index_name: &str,
        partition_id: u32,
    ) -> ClusterResult<()> {
        if round.missing {
            return Ok(());
        }
        let partition = self.partitions.of(index_name, partition_id);
        let _turn = partition.turn().await;
        if !self
            .failures
            .is_current(index_name, partition_id, round.claim)
        {
            return Ok(());
        }
        let Some(index_uuid) = round.index_uuid.clone() else {
            lock(&partition.log).clear();
            return Ok(());
        };
        let name = index_name.to_string();
        let emptied = self
            .on_copies(move |copies| copies.empty_partition(&name, &index_uuid, partition_id))
            .await;
        match emptied {
            Ok(true) => lock(&partition.log).clear(),
            Ok(false) => {}
            Err(error) if error.code() == codes::INDEX_NOT_FOUND => {}
            Err(error) => return Err(error),
        }
        Ok(())
    }

    async fn reload_once(&self, round: &mut Round, index_name: &str, partition_id: u32) -> bool {
        if round.missing {
            return false;
        }
        if let Some(reloaded) = round.reloaded {
            return reloaded;
        }
        let partition = self.partitions.of(index_name, partition_id);
        let turn = partition.turn().await;
        let Some(index_uuid) = round.index_uuid.clone().filter(|_| {
            self.failures
                .is_current(index_name, partition_id, round.claim)
        }) else {
            return false;
        };
        let name = index_name.to_string();
        let reloaded = self
            .on_copies(move |copies| copies.reload_partition(&name, &index_uuid, partition_id))
            .await;
        if matches!(reloaded, Ok(false)) {
            return false;
        }
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
            .note_reloaded(index_name, partition_id, round.claim, reloaded);
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
    ) -> ClusterResult<bool> {
        let Some(controller) = self.coordinator.lease_holder(CONTROLLER_LEASE_KEY).await? else {
            return Ok(false);
        };
        let scope = Scope {
            index_name: index_name.to_string(),
            partition_id,
            primary_term: assignment.primary_term as u64,
            assignment,
            index_uuid: None,
        };
        self.remove_replica(&scope, &self.node_id, &controller)
            .await?;
        Ok(true)
    }
}
