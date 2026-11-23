use std::sync::Arc;
use std::time::{Duration, Instant};

use narsil::Value;
use narsil::replication::EntryOperation;

use super::super::PrimaryWrites;
use super::copy::CopyPosition;
use super::payloads::{CutoverAction, ReshardCutover, ReshardOperation};
use super::state::{ReshardCopyJob, ReshardStart, SnapshotAnswer};
use crate::constants::{
    RESHARD_FORWARD_BATCH_DOCUMENTS, RESHARD_POLL_INTERVAL_MS, RESHARD_RECORD_CHECK_INTERVAL_MS,
    RESHARD_RETRY_DELAY_MS,
};
use crate::controller::lock;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::rebalance::{is_hidden_generation, read_rebalance_record};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TailOutcome {
    Truncated,
    Stopped,
}

fn stopped_before_snapshot(job: &ReshardCopyJob) -> ClusterError {
    ClusterError::new(
        codes::PARTITION_NOT_PRIMARY,
        format!(
            "The copy of partition {} of index '{}' stopped before its snapshot",
            job.partition_id, job.index_name
        ),
    )
    .with_detail("indexName", Value::from(job.index_name.as_str()))
    .with_detail("partitionId", Value::from(job.partition_id))
}

impl PrimaryWrites {
    async fn check_record(&self, job: &ReshardCopyJob) -> ClusterResult<()> {
        self.reconcile_reshard_block(&job.index_name, &job.source_generation, job.partition_id)
            .await?;
        let record = read_rebalance_record(&self.coordinator, &job.index_name).await?;
        if record.is_none_or(|record| record.job_id != job.job_id)
            || !self.still_leading(job).await?
        {
            job.stop();
        }
        Ok(())
    }

    fn operations_from(
        &self,
        job: &ReshardCopyJob,
        first: u64,
        last: u64,
    ) -> Option<Vec<ReshardOperation>> {
        let partition = self.partitions.of(&job.source_generation, job.partition_id);
        let log = lock(&partition.log);
        (first..=last)
            .map(|seq_no| {
                let entry = log.entry_at(seq_no)?;
                Some(match (&entry.operation, &entry.document) {
                    (EntryOperation::Index, Some(document)) => ReshardOperation::Replace {
                        document_id: entry.document_id.clone(),
                        document: document.clone(),
                    },
                    _ => ReshardOperation::Remove {
                        document_id: entry.document_id.clone(),
                    },
                })
            })
            .collect()
    }

    async fn tail_log(
        self: &Arc<Self>,
        job: &Arc<ReshardCopyJob>,
        position: &mut CopyPosition,
    ) -> ClusterResult<TailOutcome> {
        let check_every = Duration::from_millis(RESHARD_RECORD_CHECK_INTERVAL_MS);
        let mut checked_at: Option<Instant> = None;
        while !job.is_stopped() {
            if checked_at.is_none_or(|checked| checked.elapsed() >= check_every) {
                checked_at = Some(Instant::now());
                let _ = self.check_record(job).await;
                if job.is_stopped() {
                    break;
                }
            }
            let end =
                self.forwardable_end_of(&job.source_generation, job.partition_id, job.primary_term);
            if end > position.forwarded_seq_no {
                let first = position.forwarded_seq_no + 1;
                let last = end.min(first + RESHARD_FORWARD_BATCH_DOCUMENTS as u64 - 1);
                let Some(operations) = self.operations_from(job, first, last) else {
                    return Ok(TailOutcome::Truncated);
                };
                if self
                    .retrying(job, || self.forward_to_generation(job, operations.clone()))
                    .await
                    .is_none()
                {
                    break;
                }
                position.forwarded_seq_no = last;
                self.record_progress(job, position, end).await?;
                continue;
            }
            if position.reported_last_seq_no != Some(end) {
                self.record_progress(job, position, end).await?;
            }
            tokio::time::sleep(Duration::from_millis(RESHARD_POLL_INTERVAL_MS)).await;
        }
        Ok(TailOutcome::Stopped)
    }

    async fn copy_once(
        self: &Arc<Self>,
        job: &Arc<ReshardCopyJob>,
        position: &mut Option<CopyPosition>,
    ) -> ClusterResult<bool> {
        if position.is_none() {
            *position = self.copy_snapshot(job).await?;
        }
        let Some(held) = position.as_mut() else {
            return Ok(false);
        };
        job.announce(held.snapshot_seq_no);
        if self.tail_log(job, held).await? == TailOutcome::Truncated {
            *position = None;
        }
        Ok(true)
    }

    async fn run_copy(self: &Arc<Self>, job: &Arc<ReshardCopyJob>) -> ClusterResult<()> {
        let mut position = self.resume_position(job).await?;
        while !job.is_stopped() {
            match self.copy_once(job, &mut position).await {
                Ok(true) => {}
                Ok(false) => return Ok(()),
                Err(error) => {
                    if !self.still_leading(job).await.unwrap_or(true) {
                        return Ok(());
                    }
                    self.report(&error);
                    tokio::time::sleep(Duration::from_millis(RESHARD_RETRY_DELAY_MS)).await;
                }
            }
        }
        Ok(())
    }

    fn spawn_copy(self: &Arc<Self>, job: Arc<ReshardCopyJob>) {
        let writes = Arc::clone(self);
        tokio::spawn(async move {
            if let Err(error) = writes.run_copy(&job).await {
                job.refuse(error.clone());
                writes.report(&error);
            }
            job.stop();
            job.refuse(stopped_before_snapshot(&job));
            let key = (job.job_id.clone(), job.partition_id);
            writes.reshard.with(|held| {
                if held
                    .jobs
                    .get(&key)
                    .is_some_and(|current| Arc::ptr_eq(current, &job))
                {
                    held.jobs.remove(&key);
                }
            });
        });
    }

    pub(super) async fn start_reshard_copy(
        self: &Arc<Self>,
        start: ReshardStart,
    ) -> ClusterResult<u64> {
        let assignment = self
            .leading_assignment(&start.source_generation, start.partition_id)
            .await?;
        let primary_term = assignment.primary_term as u64;
        let key = (start.job_id.clone(), start.partition_id);
        let (job, fresh) = self.reshard.with(|held| {
            if let Some(existing) = held.jobs.get(&key) {
                if !existing.is_stopped() && existing.primary_term == primary_term {
                    return (Arc::clone(existing), false);
                }
                existing.stop();
            }
            if is_hidden_generation(&start.source_generation) {
                held.public_names
                    .insert(start.source_generation.clone(), start.index_name.clone());
            }
            let job = Arc::new(ReshardCopyJob::new(start, primary_term));
            held.jobs.insert(key, Arc::clone(&job));
            (job, true)
        });
        let mut answer = job.snapshot_seq_no.subscribe();
        if fresh {
            self.spawn_copy(Arc::clone(&job));
        }
        loop {
            match &*answer.borrow_and_update() {
                SnapshotAnswer::Announced(snapshot_seq_no) => return Ok(*snapshot_seq_no),
                SnapshotAnswer::Refused(error) => return Err(error.clone()),
                SnapshotAnswer::Pending => {}
            }
            if answer.changed().await.is_err() {
                return Err(stopped_before_snapshot(&job));
            }
        }
    }

    pub(super) async fn apply_reshard_cutover(
        self: &Arc<Self>,
        cutover: &ReshardCutover,
    ) -> ClusterResult<u64> {
        if cutover.action == CutoverAction::Lift {
            self.reshard.with(|held| {
                held.blocks.retain(|_, block| {
                    block.job_id != cutover.job_id || block.partition_id != cutover.partition_id
                });
            });
            return Ok(0);
        }
        let record = read_rebalance_record(&self.coordinator, &cutover.index_name).await?;
        let Some(record) = record.filter(|record| record.job_id == cutover.job_id) else {
            return Err(ClusterError::new(
                codes::ALLOCATION_FAILED,
                format!(
                    "Index '{}' runs no partition count change '{}'",
                    cutover.index_name, cutover.job_id
                ),
            )
            .with_detail("indexName", Value::from(cutover.index_name.as_str()))
            .with_detail("jobId", Value::from(cutover.job_id.as_str())));
        };
        let source = record.source_generation;
        self.refuse_unserved_partition_read(&source, cutover.partition_id)
            .await?;
        let assignment = self
            .leading_assignment(&source, cutover.partition_id)
            .await?;
        self.reshard
            .with(|held| held.set_block(&source, &cutover.job_id, cutover.partition_id));
        let partition = self.partitions.of(&source, cutover.partition_id);
        drop(partition.turn().await);
        Ok(self.forwardable_end_of(
            &source,
            cutover.partition_id,
            assignment.primary_term as u64,
        ))
    }
}
