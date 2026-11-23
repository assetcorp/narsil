use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use narsil::Value;

use super::generation::renew_cluster_sync_epoch;
use super::primaries::{BLOCK, StartedCopies};
use crate::allocator::{Assignments, Table};
use crate::constants::{RESHARD_CONTROLLER_POLL_INTERVAL_MS, RESHARD_CUTOVER_TIMEOUT_MS};
use crate::controller::table::rewrite_for_current_index;
use crate::controller::{Inner, stored_table};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::rebalance::{
    RebalancePhase, RebalanceRecord, read_rebalance_progress, read_rebalance_record,
    update_rebalance_record,
};

struct BlockedPartition {
    primary: String,
    primary_term: f64,
    last_seq_no: f64,
}

type Blocked = HashMap<u64, BlockedPartition>;

#[derive(PartialEq, Eq)]
pub(super) enum CutoverOutcome {
    Swapped,
    Retry,
    Gone,
}

fn dropped_during_cutover(index_name: &str) -> ClusterError {
    ClusterError::new(
        codes::INDEX_NOT_FOUND,
        format!("Index '{index_name}' was dropped during cutover"),
    )
    .with_detail("indexName", Value::String(index_name.to_string()))
}

fn block_still_holds(source: &Table, blocked: &Blocked) -> bool {
    source.assignments.iter().all(|(partition_id, assignment)| {
        blocked.get(&(partition_id as u64)).is_some_and(|held| {
            assignment.primary.as_deref() == Some(held.primary.as_str())
                && held.primary_term == assignment.primary_term
        })
    })
}

impl Inner {
    #[allow(clippy::too_many_arguments)]
    async fn blocked_and_forwarded(
        &self,
        index_name: &str,
        record: &RebalanceRecord,
        source: &Table,
        partition_id: f64,
        blocked: &mut Blocked,
        started: &mut StartedCopies,
    ) -> ClusterResult<bool> {
        let Some(assignment) = source.assignments.get(partition_id) else {
            return Ok(false);
        };
        let Some(primary) = assignment.primary.clone() else {
            return Ok(false);
        };
        let key = partition_id as u64;
        let fresh = blocked.get(&key).is_none_or(|held| {
            held.primary != primary || held.primary_term != assignment.primary_term
        });
        if fresh {
            self.ensure_copy_started(index_name, record, source, partition_id, started, None)
                .await?;
            let last_seq_no = self
                .send_reshard_cutover(index_name, record, partition_id, &primary, BLOCK)
                .await?;
            blocked.insert(
                key,
                BlockedPartition {
                    primary,
                    primary_term: assignment.primary_term,
                    last_seq_no,
                },
            );
        }
        let Some(current) = blocked.get(&key) else {
            return Ok(false);
        };
        let progress =
            read_rebalance_progress(self.coordinator(), index_name, partition_id as u32).await?;
        Ok(progress.is_some_and(|progress| {
            progress.job_id == record.job_id
                && progress.primary_term as f64 == current.primary_term
                && progress.forwarded_seq_no as f64 >= current.last_seq_no
        }))
    }

    async fn every_partition_caught_up(
        &self,
        index_name: &str,
        record: &RebalanceRecord,
        blocked: &mut Blocked,
        started: &mut StartedCopies,
    ) -> ClusterResult<bool> {
        let Some(source) = stored_table(self.coordinator(), &record.source_generation).await?
        else {
            return Err(dropped_during_cutover(&record.source_generation));
        };
        let mut every = true;
        for partition_id in source.assignments.ids() {
            match self
                .blocked_and_forwarded(index_name, record, &source, partition_id, blocked, started)
                .await
            {
                Ok(true) => {}
                Ok(false) => every = false,
                Err(error) => {
                    self.report(index_name, &error);
                    every = false;
                }
            }
        }
        Ok(every)
    }

    async fn swap_index_name(
        &self,
        index_name: &str,
        record: &RebalanceRecord,
        blocked: &Blocked,
        epoch_renewed: &mut bool,
    ) -> ClusterResult<bool> {
        let Some(name_table) = stored_table(self.coordinator(), index_name).await? else {
            return Err(dropped_during_cutover(index_name));
        };
        if name_table.generation.as_deref() == Some(record.target_generation.as_str()) {
            return Ok(true);
        }
        let source = if record.source_generation == index_name {
            Some(name_table.clone())
        } else {
            stored_table(self.coordinator(), &record.source_generation).await?
        };
        if !source.is_some_and(|source| block_still_holds(&source, blocked)) {
            return Ok(false);
        }
        let target = stored_table(self.coordinator(), &record.target_generation).await?;
        let pointer = Table {
            index_name: index_name.to_string(),
            version: name_table.version + 1.0,
            replication_factor: target
                .as_ref()
                .map_or(name_table.replication_factor, |target| {
                    target.replication_factor
                }),
            assignments: Assignments::default(),
            generation: Some(record.target_generation.clone()),
            index_uuid: name_table.index_uuid.clone(),
        };
        let Some(rewritten) = rewrite_for_current_index(self.coordinator(), pointer).await? else {
            return Ok(false);
        };
        if !*epoch_renewed {
            if !renew_cluster_sync_epoch(self.coordinator(), index_name).await? {
                return Ok(false);
            }
            *epoch_renewed = true;
        }
        self.coordinator()
            .put_allocation_guarded(
                index_name,
                &rewritten.to_stored(),
                Some(name_table.version),
                self.node_id(),
                None,
            )
            .await
    }

    pub(super) async fn attempt_cutover(
        self: &Arc<Self>,
        index_name: &str,
        record: &RebalanceRecord,
        started: &mut StartedCopies,
        is_live: &(dyn Fn() -> bool + Sync),
    ) -> ClusterResult<CutoverOutcome> {
        let cut =
            update_rebalance_record(self.coordinator(), index_name, &record.job_id, |current| {
                if current.phase == RebalancePhase::Copying {
                    Some(RebalanceRecord {
                        phase: RebalancePhase::Cutover,
                        cutover_attempts: current.cutover_attempts + 1,
                        ..current.clone()
                    })
                } else {
                    Some(current.clone())
                }
            })
            .await?;
        let Some(cut) = cut else {
            return Ok(CutoverOutcome::Gone);
        };
        if cut.phase != RebalancePhase::Cutover {
            return Ok(CutoverOutcome::Retry);
        }
        let mut blocked = Blocked::new();
        let mut epoch_renewed = false;
        let deadline = Instant::now() + Duration::from_millis(RESHARD_CUTOVER_TIMEOUT_MS);
        while Instant::now() < deadline && is_live() {
            let latest = read_rebalance_record(self.coordinator(), index_name).await?;
            let Some(latest) = latest.filter(|latest| latest.job_id == cut.job_id) else {
                return Ok(CutoverOutcome::Gone);
            };
            if latest.phase == RebalancePhase::Aborting {
                return Ok(CutoverOutcome::Retry);
            }
            if self
                .every_partition_caught_up(index_name, &cut, &mut blocked, started)
                .await?
                && self
                    .swap_index_name(index_name, &cut, &blocked, &mut epoch_renewed)
                    .await?
            {
                return Ok(CutoverOutcome::Swapped);
            }
            tokio::time::sleep(Duration::from_millis(RESHARD_CONTROLLER_POLL_INTERVAL_MS)).await;
        }
        if !is_live() {
            return Ok(CutoverOutcome::Retry);
        }
        self.lift_every_block(index_name, &cut).await?;
        let lifted =
            update_rebalance_record(self.coordinator(), index_name, &cut.job_id, |current| {
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
        Ok(if lifted.is_none() {
            CutoverOutcome::Gone
        } else {
            CutoverOutcome::Retry
        })
    }
}
