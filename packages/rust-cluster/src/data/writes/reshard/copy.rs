use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use super::super::PrimaryWrites;
use super::payloads::ReshardOperation;
use super::state::ReshardCopyJob;
use crate::constants::{RESHARD_FORWARD_BATCH_DOCUMENTS, RESHARD_RETRY_DELAY_MS};
use crate::error::ClusterResult;
use crate::rebalance::{RebalanceProgress, read_rebalance_progress, write_rebalance_progress};

#[derive(Debug, Clone)]
pub(super) struct CopyPosition {
    pub(super) snapshot_seq_no: u64,
    pub(super) forwarded_seq_no: u64,
    pub(super) reported_last_seq_no: Option<u64>,
}

struct SnapshotPage {
    snapshot_seq_no: Option<u64>,
    cursor: Option<String>,
    operations: Vec<ReshardOperation>,
}

impl PrimaryWrites {
    pub(super) async fn still_leading(&self, job: &ReshardCopyJob) -> ClusterResult<bool> {
        let table = self.view.read(&job.source_generation).await?;
        Ok(table
            .as_ref()
            .and_then(|table| table.assignments.get(f64::from(job.partition_id)))
            .is_some_and(|assignment| {
                assignment.is_primary(&self.node_id)
                    && assignment.primary_term as u64 == job.primary_term
            }))
    }

    pub(super) async fn retrying<T, F, Fut>(&self, job: &ReshardCopyJob, mut work: F) -> Option<T>
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = ClusterResult<T>>,
    {
        let mut reported_code: Option<String> = None;
        while !job.is_stopped() {
            let error = match work().await {
                Ok(done) => return Some(done),
                Err(error) => error,
            };
            if !self.still_leading(job).await.unwrap_or(true) {
                job.stop();
                return None;
            }
            if reported_code.as_deref() != Some(error.code()) {
                reported_code = Some(error.code().to_string());
                self.report(&error);
            }
            let _ = self.view.refresh(&job.target_generation).await;
            tokio::time::sleep(Duration::from_millis(RESHARD_RETRY_DELAY_MS)).await;
        }
        None
    }

    pub(super) async fn record_progress(
        &self,
        job: &ReshardCopyJob,
        position: &mut CopyPosition,
        last_seq_no: u64,
    ) -> ClusterResult<()> {
        let progress = RebalanceProgress {
            job_id: job.job_id.clone(),
            primary_term: job.primary_term,
            snapshot_seq_no: position.snapshot_seq_no,
            forwarded_seq_no: position.forwarded_seq_no,
            source_last_seq_no: last_seq_no,
        };
        let written = write_rebalance_progress(
            &self.coordinator,
            &job.index_name,
            job.partition_id,
            &progress,
        )
        .await?;
        if !written {
            job.stop();
            return Ok(());
        }
        position.reported_last_seq_no = Some(last_seq_no);
        Ok(())
    }

    pub(super) async fn local_log_end(&self, job: &ReshardCopyJob) -> ClusterResult<u64> {
        let (name, partition_id) = (job.source_generation.clone(), job.partition_id);
        let position = self
            .on_copies(move |copies| copies.position(&name, partition_id))
            .await?;
        Ok(position.seq_no)
    }

    fn holds_log_entry(&self, job: &ReshardCopyJob, seq_no: u64) -> bool {
        let partition = self.partitions.of(&job.source_generation, job.partition_id);
        crate::controller::lock(&partition.log)
            .entry_at(seq_no)
            .is_some()
    }

    pub(super) async fn resume_position(
        &self,
        job: &ReshardCopyJob,
    ) -> ClusterResult<Option<CopyPosition>> {
        let progress =
            read_rebalance_progress(&self.coordinator, &job.index_name, job.partition_id).await?;
        let Some(progress) = progress.filter(|progress| progress.job_id == job.job_id) else {
            return Ok(None);
        };
        let local_log_end = self.local_log_end(job).await?;
        let next = progress.forwarded_seq_no + 1;
        if local_log_end < progress.forwarded_seq_no {
            return Ok(None);
        }
        if next <= local_log_end && !self.holds_log_entry(job, next) {
            return Ok(None);
        }
        let mut position = CopyPosition {
            snapshot_seq_no: progress.snapshot_seq_no,
            forwarded_seq_no: progress.forwarded_seq_no,
            reported_last_seq_no: None,
        };
        let end =
            self.forwardable_end_of(&job.source_generation, job.partition_id, job.primary_term);
        self.record_progress(job, &mut position, end).await?;
        Ok((!job.is_stopped()).then_some(position))
    }

    async fn read_snapshot_page(
        &self,
        job: &ReshardCopyJob,
        cursor: Option<String>,
    ) -> ClusterResult<SnapshotPage> {
        let partition = self.partitions.of(&job.source_generation, job.partition_id);
        let _turn = partition.turn().await;
        let snapshot_seq_no = cursor.is_none().then(|| {
            self.forwardable_end_of(&job.source_generation, job.partition_id, job.primary_term)
        });
        let (name, partition_id) = (job.source_generation.clone(), job.partition_id);
        let (cursor, stored) = self
            .on_copies(move |copies| {
                let page = copies.partition_page(
                    &name,
                    partition_id,
                    cursor,
                    RESHARD_FORWARD_BATCH_DOCUMENTS,
                )?;
                let stored = copies.stored_entries(&name, page.document_ids)?;
                Ok((page.cursor, stored))
            })
            .await?;
        let operations = stored
            .into_iter()
            .map(|(document_id, document)| ReshardOperation::Replace {
                document_id,
                document,
            })
            .collect();
        Ok(SnapshotPage {
            snapshot_seq_no,
            cursor,
            operations,
        })
    }

    pub(super) async fn copy_snapshot(
        self: &Arc<Self>,
        job: &Arc<ReshardCopyJob>,
    ) -> ClusterResult<Option<CopyPosition>> {
        if self
            .retrying(job, || self.purge_generation(job))
            .await
            .is_none()
        {
            return Ok(None);
        }
        let mut snapshot_seq_no = 0;
        let mut cursor: Option<String> = None;
        loop {
            let page_cursor = cursor.clone();
            let Some(page) = self
                .retrying(job, || self.read_snapshot_page(job, page_cursor.clone()))
                .await
            else {
                return Ok(None);
            };
            if let Some(first) = page.snapshot_seq_no {
                snapshot_seq_no = first;
            }
            job.announce(snapshot_seq_no);
            let operations = page.operations;
            if self
                .retrying(job, || self.forward_to_generation(job, operations.clone()))
                .await
                .is_none()
            {
                return Ok(None);
            }
            cursor = page.cursor;
            if cursor.is_none() {
                break;
            }
        }
        let mut position = CopyPosition {
            snapshot_seq_no,
            forwarded_seq_no: snapshot_seq_no,
            reported_last_seq_no: None,
        };
        let end =
            self.forwardable_end_of(&job.source_generation, job.partition_id, job.primary_term);
        self.record_progress(job, &mut position, end).await?;
        Ok((!job.is_stopped()).then_some(position))
    }
}
