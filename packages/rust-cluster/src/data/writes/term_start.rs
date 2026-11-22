use std::sync::Arc;
use std::time::Duration;

use tokio::task::JoinSet;

use super::PrimaryWrites;
use super::errors::lost_term;
use super::partition::Partition;
use super::replicate::{chunked, in_sync_targets};
use super::scope::Scope;
use crate::constants::{
    OUT_OF_STEP_REMOVAL_RETRY_DELAY_CAP_MS, OUT_OF_STEP_REMOVAL_RETRY_INITIAL_DELAY_MS,
};
use crate::controller::lock;
use crate::message::message_types;
use crate::payload::term_start::{TermStart, encode_term_start, term_start_ack_of};

impl PrimaryWrites {
    pub(super) async fn start_term_in_queue(
        self: &Arc<Self>,
        partition: &Partition,
        scope: &Scope,
    ) -> bool {
        let claimed = {
            let mut terms = lock(&partition.terms);
            if terms.started >= scope.primary_term {
                return false;
            }
            terms.started = scope.primary_term;
            let claimed = terms.out_of_step_claim <= scope.primary_term;
            if claimed {
                terms.out_of_step_claim = scope.primary_term;
            }
            claimed
        };
        let copies = in_sync_targets(&scope.assignment, &self.node_id);
        if copies.is_empty() {
            return false;
        }
        let writes = Arc::clone(self);
        let started = scope.clone();
        let mut work = tokio::spawn(async move {
            let out_of_step = writes.settle_copies(&started, copies).await;
            if claimed {
                writes.remove_out_of_step(&started, out_of_step).await;
            }
        });
        let _ = tokio::time::timeout(self.replication_timeout(), &mut work).await;
        true
    }

    async fn settle_copies(self: &Arc<Self>, scope: &Scope, copies: Vec<String>) -> Vec<String> {
        let (name, partition_id) = (scope.index_name.clone(), scope.partition_id);
        let last_seq_no = self
            .on_copies(move |copies| copies.position(&name, partition_id))
            .await
            .map(|position| position.seq_no)
            .unwrap_or(0);
        let last_primary_term = self.term_at(scope, last_seq_no).await.unwrap_or(0);
        let request = TermStart {
            index_name: scope.index_name.clone(),
            partition_id: scope.partition_id,
            primary_term: scope.primary_term,
            last_seq_no,
            last_primary_term,
            index_uuid: scope.index_uuid.clone(),
        };
        let mut settling = JoinSet::new();
        for copy in copies {
            let (writes, scope, request) = (Arc::clone(self), scope.clone(), request.clone());
            settling.spawn(async move {
                let in_step = writes.settle_copy(&scope, &request, &copy).await;
                (copy, in_step)
            });
        }
        let mut out_of_step = Vec::new();
        while let Some(joined) = settling.join_next().await {
            if let Ok((copy, false)) = joined {
                out_of_step.push(copy);
            }
        }
        out_of_step
    }

    async fn settle_copy(self: &Arc<Self>, scope: &Scope, request: &TermStart, copy: &str) -> bool {
        let Ok(message) = self.message(
            message_types::REPLICATION_TERM_START,
            encode_term_start(request),
        ) else {
            return false;
        };
        let Ok(answer) = self.send_to_node(copy, &message).await else {
            return false;
        };
        if answer.message_type != message_types::REPLICATION_TERM_START_ACK {
            return false;
        }
        let Some(held) = term_start_ack_of(&answer.payload, request) else {
            return false;
        };
        if held.last_seq_no == request.last_seq_no
            && held.last_primary_term == request.last_primary_term
        {
            return true;
        }
        if held.last_seq_no >= request.last_seq_no
            || self.term_at(scope, held.last_seq_no).await != Some(held.last_primary_term)
        {
            return false;
        }
        self.send_missing_entries(scope, copy, held.last_seq_no)
            .await
    }

    async fn send_missing_entries(
        self: &Arc<Self>,
        scope: &Scope,
        copy: &str,
        held_seq_no: u64,
    ) -> bool {
        let partition = self.partitions.of(&scope.index_name, scope.partition_id);
        let missing = lock(&partition.log).entries_from(held_seq_no + 1);
        let Some(missing) = missing else {
            return false;
        };
        let target = [copy.to_string()];
        for chunk in chunked(&missing) {
            match self.send_entries(scope, chunk, &target).await {
                Ok(sent) if sent.iter().all(|(_, acknowledged)| *acknowledged) => {}
                _ => return false,
            }
        }
        true
    }

    fn out_of_step_abandoned(&self, scope: &Scope) -> bool {
        let partition = self.partitions.of(&scope.index_name, scope.partition_id);
        self.is_stopping() || lock(&partition.terms).out_of_step_claim != scope.primary_term
    }

    async fn try_out_of_step_removal(
        self: &Arc<Self>,
        scope: &Scope,
        pending: &mut Vec<String>,
        refresh: bool,
    ) -> crate::error::ClusterResult<bool> {
        if refresh && !pending.is_empty() {
            let current = self.leading_assignment(scope).await?;
            let partition = self.partitions.of(&scope.index_name, scope.partition_id);
            let terms = lock(&partition.terms);
            pending.retain(|copy| {
                current.holds_in_sync(copy) && !terms.removed_under(copy, scope.primary_term)
            });
        }
        if pending.is_empty() {
            return Ok(true);
        }
        let controller = self.controller_for_removal(scope).await?;
        while let Some(copy) = pending.first().cloned() {
            if self.out_of_step_abandoned(scope) {
                return Ok(false);
            }
            self.remove_replica(scope, &copy, &controller).await?;
            pending.remove(0);
        }
        Ok(true)
    }

    async fn attempt_out_of_step_removal(
        self: &Arc<Self>,
        scope: &Scope,
        pending: &mut Vec<String>,
        refresh: bool,
    ) -> Result<bool, bool> {
        if self.out_of_step_abandoned(scope) {
            return Err(true);
        }
        let attempt = self.try_out_of_step_removal(scope, pending, refresh);
        match tokio::time::timeout(self.replication_timeout(), attempt).await {
            Ok(Ok(done)) => Ok(done),
            Ok(Err(error)) if lost_term(&error) => Err(true),
            Ok(Err(_)) | Err(_) => Ok(false),
        }
    }

    async fn remove_out_of_step(self: &Arc<Self>, scope: &Scope, copies: Vec<String>) {
        let mut pending = copies;
        let mut delay_ms = OUT_OF_STEP_REMOVAL_RETRY_INITIAL_DELAY_MS;
        let mut refresh = false;
        loop {
            match self
                .attempt_out_of_step_removal(scope, &mut pending, refresh)
                .await
            {
                Ok(true) | Err(_) => break,
                Ok(false) => {}
            }
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            delay_ms = (delay_ms * 2).min(OUT_OF_STEP_REMOVAL_RETRY_DELAY_CAP_MS);
            refresh = true;
        }
        let partition = self.partitions.of(&scope.index_name, scope.partition_id);
        let mut terms = lock(&partition.terms);
        if terms.out_of_step_claim == scope.primary_term {
            terms.out_of_step_claim = 0;
        }
    }
}
