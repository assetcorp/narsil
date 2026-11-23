use narsil::Value;

use super::super::PrimaryWrites;
use super::payloads::{ReshardForward, ReshardPurge};
use crate::allocator::Table;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::rebalance::{RebalanceRecord, is_hidden_generation, read_rebalance_record};

pub(super) struct JobTarget<'p> {
    job_id: &'p str,
    target_generation: &'p str,
}

impl<'p> From<&'p ReshardForward> for JobTarget<'p> {
    fn from(payload: &'p ReshardForward) -> JobTarget<'p> {
        JobTarget {
            job_id: &payload.job_id,
            target_generation: &payload.target_generation,
        }
    }
}

impl<'p> From<&'p ReshardPurge> for JobTarget<'p> {
    fn from(payload: &'p ReshardPurge) -> JobTarget<'p> {
        JobTarget {
            job_id: &payload.job_id,
            target_generation: &payload.target_generation,
        }
    }
}

fn writes_to(record: Option<&RebalanceRecord>, payload: &JobTarget<'_>) -> bool {
    record.is_some_and(|record| {
        record.job_id == payload.job_id && record.target_generation == payload.target_generation
    })
}

fn no_running_job(payload: &JobTarget<'_>) -> ClusterError {
    ClusterError::new(
        codes::ALLOCATION_FAILED,
        format!(
            "No partition count change '{}' copies documents into '{}'",
            payload.job_id, payload.target_generation
        ),
    )
    .with_detail("jobId", Value::from(payload.job_id))
    .with_detail("targetGeneration", Value::from(payload.target_generation))
}

fn leads_any_partition(table: Option<&Table>, node_id: &str) -> bool {
    table.is_some_and(|table| {
        table
            .assignments
            .iter()
            .any(|(_, assignment)| assignment.is_primary(node_id))
    })
}

impl PrimaryWrites {
    async fn leads_target_generation(&self, target_generation: &str) -> ClusterResult<bool> {
        if leads_any_partition(
            self.view.read(target_generation).await?.as_ref(),
            &self.node_id,
        ) {
            return Ok(true);
        }
        Ok(leads_any_partition(
            self.view.refresh(target_generation).await?.as_ref(),
            &self.node_id,
        ))
    }

    pub(super) async fn assert_running_job(&self, payload: JobTarget<'_>) -> ClusterResult<()> {
        let payload = &payload;
        let target_generation = payload.target_generation;
        if !is_hidden_generation(target_generation) {
            return Err(no_running_job(payload));
        }
        if !self.leads_target_generation(target_generation).await? {
            return Err(no_running_job(payload));
        }
        let known = self
            .reshard
            .with(|held| held.public_names.get(target_generation).cloned());
        if let Some(known) = known {
            let record = read_rebalance_record(&self.coordinator, &known).await?;
            if writes_to(record.as_ref(), payload) {
                return Ok(());
            }
            return Err(no_running_job(payload));
        }
        for name in self.coordinator.list_schemas().await? {
            if is_hidden_generation(&name) {
                continue;
            }
            let record = read_rebalance_record(&self.coordinator, &name).await?;
            if writes_to(record.as_ref(), payload) {
                self.reshard.with(|held| {
                    held.public_names
                        .insert(target_generation.to_string(), name)
                });
                return Ok(());
            }
        }
        Err(no_running_job(payload))
    }
}
