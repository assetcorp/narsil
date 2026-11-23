use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use narsil::{Map, Value};
use tokio::task::JoinSet;

use super::super::PrimaryWrites;
use super::super::forward::routed_partition;
use super::payloads::{ReshardForward, ReshardOperation, ReshardPurge};
use super::state::ReshardCopyJob;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::message_types;
use crate::rebalance::{RebalanceExchange, exchange_rebalance_message};
use crate::wire_size::wire_batches;

fn document_bytes(operation: &ReshardOperation) -> usize {
    match operation {
        ReshardOperation::Replace { document, .. } => document.len(),
        ReshardOperation::Remove { .. } => 0,
    }
}

fn assert_every_operation_applied(reply: &Map, sent: usize, primary: &str) -> ClusterResult<()> {
    let results: &[Value] = match reply.get("results") {
        Some(Value::Array(results)) => results,
        _ => &[],
    };
    if results.len() != sent {
        return Err(ClusterError::new(
            codes::REPLICATION_ENTRY_INVALID,
            format!(
                "Node '{primary}' answered {} of {sent} copied documents",
                results.len()
            ),
        )
        .with_detail("primaryNodeId", Value::from(primary)));
    }
    for result in results {
        let empty = Map::new();
        let answer = match result {
            Value::Object(answer) => answer,
            _ => &empty,
        };
        if answer.get("success") == Some(&Value::Bool(true)) {
            continue;
        }
        let code = answer
            .get("errorCode")
            .and_then(Value::as_str)
            .unwrap_or(codes::REPLICATION_ENTRY_INVALID);
        let message = answer
            .get("errorMessage")
            .and_then(Value::as_str)
            .unwrap_or("a copied document was refused");
        let mut error = ClusterError::new(code, message);
        if let Some(Value::Object(details)) = answer.get("errorDetails") {
            for (key, value) in details.iter() {
                error = error.with_detail(key, value.clone());
            }
        }
        return Err(error.with_detail("primaryNodeId", Value::from(primary)));
    }
    Ok(())
}

impl PrimaryWrites {
    async fn generation_primaries(&self, job: &ReshardCopyJob) -> ClusterResult<Vec<String>> {
        let expected = job.target_partition_count as usize;
        let mut table = self.view.read(&job.target_generation).await?;
        if table
            .as_ref()
            .is_none_or(|table| table.assignments.len() != expected)
        {
            table = self.view.refresh(&job.target_generation).await?;
        }
        (0..job.target_partition_count)
            .map(|partition_id| {
                table
                    .as_ref()
                    .and_then(|table| table.assignments.get(f64::from(partition_id)))
                    .and_then(|assignment| assignment.primary.clone())
                    .ok_or_else(|| {
                        ClusterError::new(
                            codes::PARTITION_UNASSIGNED,
                            format!(
                                "Partition {partition_id} of index '{}' has no primary to copy documents into",
                                job.target_generation
                            ),
                        )
                        .with_detail("indexName", Value::from(job.target_generation.as_str()))
                        .with_detail("partitionId", Value::from(partition_id))
                    })
            })
            .collect()
    }

    async fn send_to_generation_primary(
        &self,
        primary: &str,
        message_type: &str,
        target_generation: &str,
        payload: Value,
    ) -> ClusterResult<Map> {
        let mut details = Map::with_capacity(2);
        details.insert("indexName", Value::from(target_generation));
        details.insert("primaryNodeId", Value::from(primary));
        exchange_rebalance_message(RebalanceExchange {
            transport: self.transport.as_ref(),
            sender_id: &self.node_id,
            targets: self.view.targets(primary),
            message_type,
            payload,
            failure_message: format!(
                "Node '{primary}' did not answer {message_type} for index '{target_generation}'"
            ),
            details,
        })
        .await
    }

    async fn forward_chunks(
        self: Arc<Self>,
        job: Arc<ReshardCopyJob>,
        primary: String,
        grouped: Vec<ReshardOperation>,
    ) -> ClusterResult<()> {
        for chunk in wire_batches(&grouped, document_bytes, |_, _| true) {
            let payload = ReshardForward {
                target_generation: job.target_generation.clone(),
                job_id: job.job_id.clone(),
                source_partition_id: job.partition_id,
                source_primary_term: job.primary_term,
                operations: chunk.to_vec(),
            };
            let reply = self
                .send_to_generation_primary(
                    &primary,
                    message_types::CLUSTER_RESHARD_FORWARD,
                    &job.target_generation,
                    payload.encoded(),
                )
                .await?;
            assert_every_operation_applied(&reply, chunk.len(), &primary)?;
        }
        Ok(())
    }

    pub(super) async fn forward_to_generation(
        self: &Arc<Self>,
        job: &Arc<ReshardCopyJob>,
        operations: Vec<ReshardOperation>,
    ) -> ClusterResult<()> {
        if operations.is_empty() {
            return Ok(());
        }
        let primaries = self.generation_primaries(job).await?;
        let target_partition_count = job.target_partition_count as usize;
        let mut by_primary: BTreeMap<String, Vec<ReshardOperation>> = BTreeMap::new();
        for operation in operations {
            let partition_id = routed_partition(operation.document_id(), target_partition_count);
            let Some(primary) = primaries.get(partition_id as usize) else {
                continue;
            };
            by_primary
                .entry(primary.clone())
                .or_default()
                .push(operation);
        }
        let mut sends = JoinSet::new();
        for (primary, grouped) in by_primary {
            sends.spawn(Arc::clone(self).forward_chunks(Arc::clone(job), primary, grouped));
        }
        joined_all(sends).await
    }

    pub(super) async fn purge_generation(
        self: &Arc<Self>,
        job: &Arc<ReshardCopyJob>,
    ) -> ClusterResult<()> {
        let primaries: BTreeSet<String> =
            self.generation_primaries(job).await?.into_iter().collect();
        let mut sends = JoinSet::new();
        for primary in primaries {
            let writes = Arc::clone(self);
            let payload = ReshardPurge {
                target_generation: job.target_generation.clone(),
                job_id: job.job_id.clone(),
                source_partition_count: job.source_partition_count,
                source_partition_id: job.partition_id,
            };
            sends.spawn(async move {
                writes
                    .send_to_generation_primary(
                        &primary,
                        message_types::CLUSTER_RESHARD_PURGE,
                        &payload.target_generation,
                        payload.encoded(),
                    )
                    .await
                    .map(|_| ())
            });
        }
        joined_all(sends).await
    }
}

async fn joined_all(mut sends: JoinSet<ClusterResult<()>>) -> ClusterResult<()> {
    let mut failure = None;
    while let Some(joined) = sends.join_next().await {
        let outcome = joined.unwrap_or_else(|error| {
            Err(ClusterError::new(
                codes::INTERNAL_ERROR,
                format!("A partition copy send stopped: {error}"),
            ))
        });
        if let Err(error) = outcome {
            failure.get_or_insert(error);
        }
    }
    failure.map_or(Ok(()), Err)
}
