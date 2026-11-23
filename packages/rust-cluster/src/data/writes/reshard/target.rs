use std::collections::{BTreeMap, HashSet, VecDeque};
use std::sync::Arc;

use narsil::Value;
use tokio::task::JoinSet;

use super::super::PrimaryWrites;
use super::super::condition::Resends;
use super::super::forward::routed_partition;
use super::super::partition::QueueTurn;
use super::super::run::Planned;
use super::super::scope::{Outcome, Scope};
use super::payloads::{ReshardForward, ReshardOperation, ReshardPurge};
use super::running_job::JobTarget;
use crate::allocator::Table;
use crate::constants::RESHARD_FORWARD_BATCH_DOCUMENTS;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::payload::forward::{ForwardKind, ForwardOperation, WriteFailure};

type Queued = VecDeque<(usize, ReshardOperation)>;

fn no_allocation_table(index_name: &str) -> ClusterError {
    ClusterError::new(
        codes::INDEX_NOT_FOUND,
        format!("Index '{index_name}' has no allocation table"),
    )
    .with_detail("indexName", Value::from(index_name))
}

impl PrimaryWrites {
    async fn holds_document(&self, index_name: &str, document_id: &str) -> ClusterResult<bool> {
        let (name, id) = (index_name.to_string(), document_id.to_string());
        let held = self
            .on_copies(move |copies| copies.document(&name, &id))
            .await?;
        Ok(held.is_some())
    }

    async fn apply_next_run(
        self: &Arc<Self>,
        scope: Scope,
        turn: QueueTurn,
        pending: &mut Queued,
        resends: &mut Resends,
    ) -> Vec<(usize, Outcome)> {
        let mut outcomes = Vec::new();
        let mut run: Vec<Planned> = Vec::new();
        let mut run_kind = None;
        let mut planned_ids = HashSet::new();
        while let Some((_, operation)) = pending.front() {
            if planned_ids.contains(operation.document_id()) {
                break;
            }
            let held = self
                .holds_document(&scope.index_name, operation.document_id())
                .await;
            let kind = match (operation, held) {
                (_, Err(error)) => {
                    if let Some((position, _)) = pending.pop_front() {
                        outcomes.push((position, Err(WriteFailure::from(error))));
                    }
                    continue;
                }
                (ReshardOperation::Remove { .. }, Ok(false)) => {
                    if let Some((position, _)) = pending.pop_front() {
                        outcomes.push((position, Ok(())));
                    }
                    continue;
                }
                (ReshardOperation::Remove { .. }, Ok(true)) => ForwardKind::Remove,
                (ReshardOperation::Replace { .. }, Ok(true)) => ForwardKind::Update,
                (ReshardOperation::Replace { .. }, Ok(false)) => ForwardKind::Insert,
            };
            if run_kind.is_some_and(|run_kind| run_kind != kind) {
                break;
            }
            run_kind = Some(kind);
            let Some((position, operation)) = pending.pop_front() else {
                break;
            };
            let (document_id, document) = match operation {
                ReshardOperation::Replace {
                    document_id,
                    document,
                } => (document_id, Some(document)),
                ReshardOperation::Remove { document_id } => (document_id, None),
            };
            planned_ids.insert(document_id.clone());
            run.push(Planned {
                position,
                operation: ForwardOperation {
                    document_id,
                    kind,
                    document,
                    update_fields: None,
                    condition: Ok(None),
                },
            });
        }
        if let Some(kind) = run_kind {
            outcomes.extend(self.apply_run(scope, turn, kind, run, resends).await);
        }
        outcomes
    }

    async fn apply_in_partition(
        self: Arc<Self>,
        index_name: String,
        partition_id: u32,
        mut pending: Queued,
    ) -> Vec<(usize, Outcome)> {
        let mut outcomes = Vec::with_capacity(pending.len());
        let mut resends = Resends::new();
        while !pending.is_empty() {
            let positions: Vec<usize> = pending.iter().map(|(position, _)| *position).collect();
            let mut ran = false;
            let writes = Arc::clone(&self);
            let (queued, held_resends, task_ran) = (&mut pending, &mut resends, &mut ran);
            let applied = self
                .in_leading_queue(
                    &index_name,
                    partition_id,
                    &positions,
                    move |scope, turn| async move {
                        *task_ran = true;
                        writes
                            .apply_next_run(scope, turn, queued, held_resends)
                            .await
                    },
                )
                .await;
            outcomes.extend(applied);
            if !ran {
                break;
            }
        }
        outcomes
    }

    async fn generation_partition_count(&self, index_name: &str) -> ClusterResult<usize> {
        let routable = |table: Option<Table>| table.filter(|table| !table.assignments.is_empty());
        let table = match routable(self.view.read(index_name).await?) {
            Some(table) => table,
            None => routable(self.view.refresh(index_name).await?)
                .ok_or_else(|| no_allocation_table(index_name))?,
        };
        Ok(table.assignments.len())
    }

    async fn apply_operations(
        self: &Arc<Self>,
        index_name: &str,
        operations: Vec<ReshardOperation>,
    ) -> ClusterResult<Vec<Outcome>> {
        let count = operations.len();
        let partition_count = self.generation_partition_count(index_name).await?;
        let mut by_partition: BTreeMap<u32, Queued> = BTreeMap::new();
        for (position, operation) in operations.into_iter().enumerate() {
            let partition_id = routed_partition(operation.document_id(), partition_count);
            by_partition
                .entry(partition_id)
                .or_default()
                .push_back((position, operation));
        }
        let mut partitions = JoinSet::new();
        for (partition_id, queued) in by_partition {
            let writes = Arc::clone(self);
            partitions.spawn(writes.apply_in_partition(
                index_name.to_string(),
                partition_id,
                queued,
            ));
        }
        let mut answered: Vec<Option<Outcome>> = (0..count).map(|_| None).collect();
        while let Some(joined) = partitions.join_next().await {
            let Ok(outcomes) = joined else {
                continue;
            };
            for (position, outcome) in outcomes {
                if let Some(slot) = answered.get_mut(position) {
                    *slot = Some(outcome);
                }
            }
        }
        let unanswered = || {
            ClusterError::new(
                codes::REPLICATION_ENTRY_INVALID,
                format!("A copied document for index '{index_name}' stopped before it answered"),
            )
        };
        Ok(answered
            .into_iter()
            .map(|outcome| outcome.unwrap_or_else(|| Err(WriteFailure::from(unanswered()))))
            .collect())
    }

    pub(super) async fn apply_reshard_forward(
        self: &Arc<Self>,
        payload: ReshardForward,
    ) -> ClusterResult<Vec<(String, Outcome)>> {
        self.assert_running_job(JobTarget::from(&payload)).await?;
        let key = (payload.job_id.clone(), payload.source_partition_id);
        let below = self.reshard.with(|held| {
            let accepted = held.accepted_terms.get(&key).copied().unwrap_or(0);
            if payload.source_primary_term < accepted {
                return Some(accepted);
            }
            held.accepted_terms
                .insert(key.clone(), payload.source_primary_term);
            None
        });
        if let Some(accepted) = below {
            return Err(ClusterError::new(
                codes::REPLICATION_TERM_MISMATCH,
                format!(
                    "Partition {} sent copied documents under term {}, below term {accepted}",
                    payload.source_partition_id, payload.source_primary_term
                ),
            )
            .with_detail("jobId", Value::from(payload.job_id.as_str()))
            .with_detail(
                "sourcePartitionId",
                Value::from(payload.source_partition_id),
            )
            .with_detail("acceptedTerm", Value::from(accepted)));
        }
        let document_ids: Vec<String> = payload
            .operations
            .iter()
            .map(|operation| operation.document_id().to_string())
            .collect();
        let outcomes = self
            .apply_operations(&payload.target_generation, payload.operations)
            .await?;
        Ok(document_ids.into_iter().zip(outcomes).collect())
    }

    pub(super) async fn purge_reshard_source(
        self: &Arc<Self>,
        payload: ReshardPurge,
    ) -> ClusterResult<u64> {
        self.assert_running_job(JobTarget::from(&payload)).await?;
        let table = self.view.read(&payload.target_generation).await?;
        let led: Vec<u32> = table
            .iter()
            .flat_map(|table| table.assignments.iter())
            .filter(|(_, assignment)| assignment.is_primary(&self.node_id))
            .map(|(partition_id, _)| partition_id as u32)
            .collect();
        let mut removed = 0u64;
        for partition_id in led {
            let mut cursor = None;
            loop {
                let (name, page_cursor) = (payload.target_generation.clone(), cursor.take());
                let page = self
                    .on_copies(move |copies| {
                        copies.partition_page(
                            &name,
                            partition_id,
                            page_cursor,
                            RESHARD_FORWARD_BATCH_DOCUMENTS,
                        )
                    })
                    .await?;
                let removals: Vec<ReshardOperation> = page
                    .document_ids
                    .into_iter()
                    .filter(|id| {
                        routed_partition(id, payload.source_partition_count as usize)
                            == payload.source_partition_id
                    })
                    .map(|document_id| ReshardOperation::Remove { document_id })
                    .collect();
                let count = removals.len() as u64;
                let document_ids: Vec<String> = removals
                    .iter()
                    .map(|removal| removal.document_id().to_string())
                    .collect();
                let outcomes = self
                    .apply_operations(&payload.target_generation, removals)
                    .await?;
                for (document_id, outcome) in document_ids.iter().zip(outcomes) {
                    if let Err(failure) = outcome {
                        let mut error = failure.error;
                        error = error
                            .with_detail(
                                "indexName",
                                Value::from(payload.target_generation.as_str()),
                            )
                            .with_detail("documentId", Value::from(document_id.as_str()));
                        return Err(error);
                    }
                }
                removed += count;
                match page.cursor {
                    Some(next) => cursor = Some(next),
                    None => break,
                }
            }
        }
        Ok(removed)
    }
}
