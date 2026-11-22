use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::task::JoinSet;

use super::PrimaryWrites;
use super::errors::lost_term;
use super::partition::Partition;
use super::replicate::in_sync_targets;
use super::scope::Scope;
use crate::constants::{
    OUT_OF_STEP_REMOVAL_RETRY_DELAY_CAP_MS, OUT_OF_STEP_REMOVAL_RETRY_INITIAL_DELAY_MS,
};
use crate::controller::lock;
use crate::error::ClusterResult;
use crate::message::message_types;
use crate::payload::term_start::{TermStart, encode_term_start, term_start_ack_of};

fn claim_term(partition: &Partition, primary_term: u64) -> Option<(u64, bool)> {
    let mut terms = lock(&partition.terms);
    if terms.started >= primary_term {
        return None;
    }
    let previous = terms.started;
    terms.started = primary_term;
    let claimed = terms.out_of_step_claim < primary_term;
    if claimed {
        terms.out_of_step_claim = primary_term;
    }
    Some((previous, claimed))
}

fn release_term(partition: &Partition, primary_term: u64, previous: u64, claimed: bool) {
    let mut terms = lock(&partition.terms);
    if terms.started == primary_term {
        terms.started = previous;
    }
    if claimed && terms.out_of_step_claim == primary_term {
        terms.out_of_step_claim = 0;
    }
}

fn copies_out_of_step(
    partition: &Partition,
    scope: &Scope,
    copies: Vec<String>,
    in_step: &Mutex<HashSet<String>>,
) -> Vec<String> {
    let in_step = lock(in_step).clone();
    let terms = lock(&partition.terms);
    copies
        .into_iter()
        .filter(|copy| !in_step.contains(copy) && !terms.removed_under(copy, scope.primary_term))
        .collect()
}

impl PrimaryWrites {
    pub(crate) fn start_led_term(
        self: &Arc<Self>,
        index_name: &str,
        partition_id: u32,
        primary_term: u64,
    ) {
        let partition = self.partitions.of(index_name, partition_id);
        {
            let mut terms = lock(&partition.terms);
            if terms.started >= primary_term || terms.watch_start >= primary_term {
                return;
            }
            terms.watch_start = primary_term;
        }
        let (writes, index_name) = (Arc::clone(self), index_name.to_string());
        tokio::spawn(async move {
            if !writes.is_stopping() {
                let _turn = partition.turn().await;
                if let Ok(scope) = writes
                    .current_scope(&partition, &index_name, partition_id)
                    .await
                {
                    let _ = writes.start_term_in_queue(&partition, &scope).await;
                }
            }
            let mut terms = lock(&partition.terms);
            if terms.watch_start == primary_term {
                terms.watch_start = 0;
            }
        });
    }

    pub(super) async fn start_term_in_queue(
        self: &Arc<Self>,
        partition: &Partition,
        scope: &Scope,
    ) -> ClusterResult<bool> {
        let Some((previous, claimed)) = claim_term(partition, scope.primary_term) else {
            return Ok(false);
        };
        let copies = in_sync_targets(&scope.assignment, &self.node_id);
        if copies.is_empty() {
            return Ok(false);
        }
        let in_step = Arc::new(Mutex::new(HashSet::new()));
        let (writes, started, settled) = (Arc::clone(self), scope.clone(), Arc::clone(&in_step));
        let starting = copies.clone();
        let mut work = tokio::spawn(async move {
            let out_of_step = writes.settle_copies(&started, starting, &settled).await;
            if claimed {
                writes.remove_out_of_step(&started, out_of_step).await;
            }
        });
        let _ = tokio::time::timeout(self.replication_timeout(), &mut work).await;
        let out_of_step = copies_out_of_step(partition, scope, copies, &in_step);
        if let Err(error) = self.remove_failed(scope, &out_of_step).await {
            work.abort();
            release_term(partition, scope.primary_term, previous, claimed);
            return Err(error);
        }
        Ok(true)
    }

    async fn settle_copies(
        self: &Arc<Self>,
        scope: &Scope,
        copies: Vec<String>,
        in_step: &Mutex<HashSet<String>>,
    ) -> Vec<String> {
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
            let Ok((copy, settled)) = joined else {
                continue;
            };
            if settled {
                lock(in_step).insert(copy);
            } else {
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
        let mut next = held_seq_no + 1;
        let Some(log_end) = lock(&partition.log).newest_seq_no() else {
            return false;
        };
        let target = [copy.to_string()];
        while next <= log_end {
            let batch = lock(&partition.log).batch_from(&scope.index_name, next, log_end);
            let (Some(first), Some(last)) = (batch.first(), batch.last()) else {
                return false;
            };
            if first.seq_no != next {
                return false;
            }
            next = last.seq_no + 1;
            match self.send_entries(scope, &batch, &target).await {
                Ok(sent) if sent.iter().all(|(_, acknowledged)| *acknowledged) => {}
                _ => return false,
            }
        }
        next > held_seq_no + 1
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
