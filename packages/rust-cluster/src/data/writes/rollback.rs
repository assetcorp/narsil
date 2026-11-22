use std::sync::Arc;
use std::time::{Duration, Instant};

use super::PrimaryWrites;
use super::errors::{ROLLBACK_OPEN, TERM_ENDED, lost_term, no_longer_leads_term, outcome_unknown};
use super::partition::QueueTurn;
use super::replicate::chunked;
use super::scope::Scope;
use crate::allocator::Assignment;
use crate::constants::{ROLLBACK_RETRY_DELAY_CAP_MS, ROLLBACK_RETRY_INITIAL_DELAY_MS};
use crate::controller::lock;
use crate::error::{ClusterError, ClusterResult};

enum RollbackEnd {
    Complete,
    Superseded,
    Stopped,
    Open,
}

impl PrimaryWrites {
    pub(super) async fn leading_assignment(
        self: &Arc<Self>,
        scope: &Scope,
    ) -> ClusterResult<Assignment> {
        let table = self.view.refresh(&scope.index_name).await?;
        let assignment = table
            .as_ref()
            .and_then(|table| table.assignments.get(f64::from(scope.partition_id)))
            .cloned();
        if let Some(assignment) = &assignment
            && assignment.is_primary(&self.node_id)
            && assignment.primary_term as u64 == scope.primary_term
            && !self
                .copy_failed(&scope.index_name, scope.partition_id)
                .await
        {
            return Ok(assignment.clone());
        }
        Err(no_longer_leads_term(
            scope,
            &self.node_id,
            assignment.as_ref(),
        ))
    }

    async fn send_rollback(
        self: &Arc<Self>,
        scope: &Scope,
        entries: &[narsil::replication::ReplicatedEntry],
    ) -> ClusterResult<()> {
        let assignment = self.leading_assignment(scope).await?;
        for chunk in chunked(entries) {
            self.replicate(scope, &assignment, chunk).await?;
        }
        Ok(())
    }

    async fn try_rollback(
        self: &Arc<Self>,
        scope: &Scope,
        entries: &[narsil::replication::ReplicatedEntry],
        delay_ms: u64,
    ) -> ClusterResult<bool> {
        let timeout = self.replication_timeout();
        match tokio::time::timeout(timeout, self.send_rollback(scope, entries)).await {
            Ok(Ok(())) => return Ok(true),
            Ok(Err(error)) if lost_term(&error) => return Err(error),
            Ok(Err(_)) | Err(_) => {}
        }
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        Ok(false)
    }

    async fn complete_rollback(self: Arc<Self>, scope: Scope, from_seq_no: u64) -> RollbackEnd {
        let partition = self.partitions.of(&scope.index_name, scope.partition_id);
        let mut delay_ms = ROLLBACK_RETRY_INITIAL_DELAY_MS;
        loop {
            if self.is_stopping() {
                return RollbackEnd::Stopped;
            }
            let entries = lock(&partition.log).entries_from(from_seq_no);
            let Some(entries) = entries.filter(|entries| !entries.is_empty()) else {
                return RollbackEnd::Superseded;
            };
            let tried = tokio::select! {
                tried = self.try_rollback(&scope, &entries, delay_ms) => tried,
                superseded = self.superseded(&scope) => Err(superseded),
            };
            match tried {
                Ok(true) => return RollbackEnd::Complete,
                Err(error) if lost_term(&error) => return RollbackEnd::Superseded,
                Ok(false) | Err(_) => {}
            }
            delay_ms = (delay_ms * 2).min(ROLLBACK_RETRY_DELAY_CAP_MS);
        }
    }

    pub(super) async fn settle_rollback(
        self: &Arc<Self>,
        scope: &Scope,
        turn: &mut QueueTurn,
        from_seq_no: u64,
        original: &ClusterError,
        failed_at: Instant,
    ) -> ClusterError {
        let timeout = self.replication_timeout();
        let mut rollback =
            turn.hold_through(Arc::clone(self).complete_rollback(scope.clone(), from_seq_no));
        let open_after = (failed_at + timeout).saturating_duration_since(Instant::now());
        let end = tokio::select! {
            joined = &mut rollback => joined.unwrap_or(RollbackEnd::Stopped),
            () = tokio::time::sleep(open_after) => RollbackEnd::Open,
        };
        match end {
            RollbackEnd::Complete => original.clone(),
            RollbackEnd::Superseded => outcome_unknown(
                scope,
                original,
                TERM_ENDED,
                "the primary lost its term before every in-sync copy dropped the write",
            ),
            RollbackEnd::Stopped => outcome_unknown(
                scope,
                original,
                ROLLBACK_OPEN,
                "the primary shut down before every in-sync copy dropped the write",
            ),
            RollbackEnd::Open => outcome_unknown(
                scope,
                original,
                ROLLBACK_OPEN,
                &format!(
                    "the primary could not confirm within {}ms that every in-sync copy dropped it",
                    timeout.as_millis()
                ),
            ),
        }
    }
}
