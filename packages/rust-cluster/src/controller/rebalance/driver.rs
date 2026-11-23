use std::sync::Arc;
use std::time::Duration;

use narsil::Value;

use super::cutover::CutoverOutcome;
use super::generation::{
    clear_every_progress, drop_generation, drop_replaced_name_synonym_set, ensure_generation,
};
use super::primaries::StartedCopies;
use crate::allocator::{ACTIVE, Table, UNASSIGNED};
use crate::constants::{
    MAX_RESHARD_CUTOVER_ATTEMPTS, RESHARD_CONTROLLER_POLL_INTERVAL_MS, RESHARD_CUTOVER_LAG_ENTRIES,
    RESHARD_RECORD_CHECK_INTERVAL_MS,
};
use crate::controller::{Inner, index_metadata, lock, stored_table};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::rebalance::{
    RebalancePhase, RebalanceRecord, read_rebalance_progress, read_rebalance_record,
    update_rebalance_record,
};

const ABORTING_CODES: [&str; 3] = [
    codes::INDEX_NOT_FOUND,
    codes::CONTROLLER_METADATA_INVALID,
    codes::CONFIG_INVALID,
];

#[derive(PartialEq, Eq)]
enum DriverStep {
    Finished,
    Continue,
}

fn serves_every_partition(table: Option<&Table>, partition_count: u64) -> bool {
    let Some(table) = table else {
        return false;
    };
    if table.assignments.len() as u64 != partition_count {
        return false;
    }
    table.assignments.values().all(|assignment| {
        let Some(primary) = assignment.primary.as_deref() else {
            return false;
        };
        assignment.state == ACTIVE
            && assignment
                .replicas
                .iter()
                .all(|node_id| node_id == primary || assignment.in_sync_set.contains(node_id))
    })
}

fn lost_a_partition(table: Option<&Table>) -> bool {
    table.is_some_and(|table| {
        table.assignments.values().any(|assignment| {
            assignment.state == UNASSIGNED
                && assignment.primary.is_none()
                && !assignment.last_holders_of().is_empty()
        })
    })
}

impl Inner {
    async fn start_copies(
        self: &Arc<Self>,
        index_name: &str,
        record: &RebalanceRecord,
        source: &Table,
        started: &mut StartedCopies,
    ) {
        let resend_after = Some(Duration::from_millis(RESHARD_RECORD_CHECK_INTERVAL_MS));
        for partition_id in source.assignments.ids() {
            if let Err(error) = self
                .ensure_copy_started(
                    index_name,
                    record,
                    source,
                    partition_id,
                    started,
                    resend_after,
                )
                .await
            {
                self.report(index_name, &error);
            }
        }
    }

    async fn copies_caught_up(
        &self,
        index_name: &str,
        record: &RebalanceRecord,
        source: &Table,
    ) -> ClusterResult<bool> {
        for (partition_id, assignment) in source.assignments.iter() {
            let progress =
                read_rebalance_progress(self.coordinator(), index_name, partition_id as u32)
                    .await?;
            let caught_up = progress.is_some_and(|progress| {
                progress.job_id == record.job_id
                    && progress.primary_term as f64 == assignment.primary_term
                    && progress
                        .source_last_seq_no
                        .saturating_sub(progress.forwarded_seq_no)
                        <= RESHARD_CUTOVER_LAG_ENTRIES
            });
            if !caught_up {
                return Ok(false);
            }
        }
        Ok(true)
    }

    async fn finish_swap(&self, index_name: &str, record: &RebalanceRecord) -> ClusterResult<()> {
        if record.source_generation == index_name {
            let metadata = index_metadata(self.coordinator(), index_name).await?;
            let partition_count = metadata.map_or(0, |metadata| metadata.partition_count as usize);
            clear_every_progress(self.coordinator(), index_name, partition_count).await?;
            drop_replaced_name_synonym_set(self.coordinator(), index_name).await?;
        } else {
            let source = stored_table(self.coordinator(), &record.source_generation).await?;
            let partition_count = source.map_or(0, |source| source.assignments.len());
            clear_every_progress(self.coordinator(), index_name, partition_count).await?;
            drop_generation(
                self.coordinator(),
                self.node_id(),
                &record.source_generation,
            )
            .await?;
        }
        update_rebalance_record(self.coordinator(), index_name, &record.job_id, |_| None).await?;
        Ok(())
    }

    async fn finish_abort(
        self: &Arc<Self>,
        index_name: &str,
        record: &RebalanceRecord,
    ) -> ClusterResult<()> {
        drop_generation(
            self.coordinator(),
            self.node_id(),
            &record.target_generation,
        )
        .await?;
        let source = stored_table(self.coordinator(), &record.source_generation).await?;
        let partition_count = source.map_or(0, |source| source.assignments.len());
        clear_every_progress(self.coordinator(), index_name, partition_count).await?;
        update_rebalance_record(self.coordinator(), index_name, &record.job_id, |_| None).await?;
        self.lift_every_block(index_name, record).await
    }

    async fn mark_aborting(&self, index_name: &str, job_id: &str) -> ClusterResult<()> {
        update_rebalance_record(self.coordinator(), index_name, job_id, |current| {
            Some(RebalanceRecord {
                phase: RebalancePhase::Aborting,
                ..current.clone()
            })
        })
        .await?;
        Ok(())
    }

    async fn advance(
        self: &Arc<Self>,
        index_name: &str,
        record: &RebalanceRecord,
        started: &mut StartedCopies,
        is_live: &(dyn Fn() -> bool + Sync),
    ) -> ClusterResult<DriverStep> {
        let name_table = stored_table(self.coordinator(), index_name).await?;
        if name_table
            .as_ref()
            .and_then(|table| table.generation.as_deref())
            == Some(record.target_generation.as_str())
        {
            self.finish_swap(index_name, record).await?;
            return Ok(DriverStep::Finished);
        }
        if record.phase == RebalancePhase::Aborting {
            self.finish_abort(index_name, record).await?;
            return Ok(DriverStep::Finished);
        }
        if record.phase == RebalancePhase::Cutover {
            self.lift_every_block(index_name, record).await?;
            update_rebalance_record(self.coordinator(), index_name, &record.job_id, |current| {
                if current.phase == RebalancePhase::Cutover {
                    Some(RebalanceRecord {
                        phase: RebalancePhase::Copying,
                        ..current.clone()
                    })
                } else {
                    Some(current.clone())
                }
            })
            .await?;
            return Ok(DriverStep::Continue);
        }
        if record.cutover_attempts >= MAX_RESHARD_CUTOVER_ATTEMPTS {
            self.mark_aborting(index_name, &record.job_id).await?;
            return Ok(DriverStep::Continue);
        }

        ensure_generation(self.coordinator(), record).await?;
        let current = read_rebalance_record(self.coordinator(), index_name).await?;
        let same_job = current
            .as_ref()
            .is_some_and(|current| current.job_id == record.job_id);
        if !same_job
            || current
                .as_ref()
                .is_some_and(|current| current.phase == RebalancePhase::Aborting)
        {
            drop_generation(
                self.coordinator(),
                self.node_id(),
                &record.target_generation,
            )
            .await?;
            return Ok(if same_job {
                DriverStep::Continue
            } else {
                DriverStep::Finished
            });
        }
        let target = stored_table(self.coordinator(), &record.target_generation).await?;
        if lost_a_partition(target.as_ref()) {
            self.mark_aborting(index_name, &record.job_id).await?;
            return Ok(DriverStep::Continue);
        }
        if !serves_every_partition(target.as_ref(), record.target_partition_count) {
            return Ok(DriverStep::Continue);
        }
        let source = if record.source_generation == index_name {
            name_table
        } else {
            stored_table(self.coordinator(), &record.source_generation).await?
        };
        let Some(source) = source else {
            return Err(ClusterError::new(
                codes::INDEX_NOT_FOUND,
                format!(
                    "Index '{}' has no allocation table",
                    record.source_generation
                ),
            )
            .with_detail("indexName", Value::String(record.source_generation.clone())));
        };
        self.start_copies(index_name, record, &source, started)
            .await;
        if !self.copies_caught_up(index_name, record, &source).await? {
            return Ok(DriverStep::Continue);
        }
        Ok(
            match self
                .attempt_cutover(index_name, record, started, is_live)
                .await?
            {
                CutoverOutcome::Swapped => {
                    self.finish_swap(index_name, record).await?;
                    DriverStep::Finished
                }
                CutoverOutcome::Gone => DriverStep::Finished,
                CutoverOutcome::Retry => DriverStep::Continue,
            },
        )
    }

    async fn drive(
        self: &Arc<Self>,
        index_name: &str,
        job_id: &str,
        is_live: &(dyn Fn() -> bool + Sync),
    ) {
        let mut started = StartedCopies::new();
        while is_live() {
            let step = match read_rebalance_record(self.coordinator(), index_name).await {
                Ok(Some(record)) if record.job_id == job_id => {
                    self.advance(index_name, &record, &mut started, is_live)
                        .await
                }
                Ok(_) => return,
                Err(error) => Err(error),
            };
            match step {
                Ok(DriverStep::Finished) => return,
                Ok(DriverStep::Continue) => {}
                Err(error) => {
                    if ABORTING_CODES.contains(&error.code()) && is_live() {
                        let _ = self.mark_aborting(index_name, job_id).await;
                    }
                    self.report(index_name, &error);
                }
            }
            tokio::time::sleep(Duration::from_millis(RESHARD_CONTROLLER_POLL_INTERVAL_MS)).await;
        }
    }

    pub(super) fn start_rebalance_driver(self: &Arc<Self>, index_name: &str, job_id: &str) {
        let epoch = {
            let mut state = lock(&self.state);
            if state.rebalance_drivers.get(index_name).map(String::as_str) == Some(job_id) {
                return;
            }
            state
                .rebalance_drivers
                .insert(index_name.to_string(), job_id.to_string());
            state.rebalance_epoch
        };
        let inner = Arc::clone(self);
        let index_name = index_name.to_string();
        let job_id = job_id.to_string();
        tokio::spawn(async move {
            let live_inner = Arc::clone(&inner);
            let is_live =
                move || live_inner.is_active() && lock(&live_inner.state).rebalance_epoch == epoch;
            inner.drive(&index_name, &job_id, &is_live).await;
            let mut state = lock(&inner.state);
            if state.rebalance_epoch == epoch
                && state.rebalance_drivers.get(&index_name).map(String::as_str)
                    == Some(job_id.as_str())
            {
                state.rebalance_drivers.remove(&index_name);
            }
        });
    }
}
