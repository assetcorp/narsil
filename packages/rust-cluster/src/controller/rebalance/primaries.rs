use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use narsil::{Map, Value};
use tokio::task::JoinSet;

use crate::allocator::Table;
use crate::controller::{Inner, stored_table};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::message_types;
use crate::rebalance::RebalanceRecord;
use crate::rebalance::{RebalanceExchange, exchange_rebalance_message};

pub(super) struct StartedCopy {
    primary_term: f64,
    sent_at: Instant,
}

pub(super) type StartedCopies = HashMap<u64, StartedCopy>;

pub(super) const BLOCK: &str = "block";
const LIFT: &str = "lift";

fn partition_key(partition_id: f64) -> u64 {
    partition_id as u64
}

impl Inner {
    async fn targets_of(&self, node_id: &str) -> ClusterResult<Vec<String>> {
        let nodes = self.coordinator().list_nodes().await?;
        let address = nodes
            .into_iter()
            .find(|node| node.node_id == node_id)
            .map(|node| node.address);
        Ok(match address {
            Some(address) if !address.is_empty() && address != node_id => {
                vec![node_id.to_string(), address]
            }
            _ => vec![node_id.to_string()],
        })
    }

    async fn send_to_primary(
        &self,
        primary: &str,
        message_type: &str,
        index_name: &str,
        partition_id: f64,
        payload: Map,
    ) -> ClusterResult<Map> {
        let mut details = Map::with_capacity(3);
        details.insert("indexName", Value::String(index_name.to_string()));
        details.insert("partitionId", Value::Number(partition_id));
        details.insert("primaryNodeId", Value::String(primary.to_string()));
        exchange_rebalance_message(RebalanceExchange {
            transport: self.config.transport.as_ref(),
            sender_id: self.node_id(),
            targets: self.targets_of(primary).await?,
            message_type,
            payload: Value::Object(payload),
            failure_message: format!(
                "Node '{primary}' did not answer {message_type} for partition {partition_id} of index '{index_name}'"
            ),
            details,
        })
        .await
    }

    async fn send_reshard_start(
        &self,
        index_name: &str,
        record: &RebalanceRecord,
        source: &Table,
        partition_id: f64,
        primary: &str,
    ) -> ClusterResult<()> {
        let mut payload = Map::with_capacity(7);
        payload.insert("indexName", Value::String(index_name.to_string()));
        payload.insert("jobId", Value::String(record.job_id.clone()));
        payload.insert(
            "sourceGeneration",
            Value::String(record.source_generation.clone()),
        );
        payload.insert(
            "targetGeneration",
            Value::String(record.target_generation.clone()),
        );
        payload.insert("partitionId", Value::Number(partition_id));
        payload.insert(
            "sourcePartitionCount",
            Value::Number(source.assignments.len() as f64),
        );
        payload.insert(
            "targetPartitionCount",
            Value::Number(record.target_partition_count as f64),
        );
        self.send_to_primary(
            primary,
            message_types::CLUSTER_RESHARD_START,
            index_name,
            partition_id,
            payload,
        )
        .await?;
        Ok(())
    }

    pub(super) async fn ensure_copy_started(
        &self,
        index_name: &str,
        record: &RebalanceRecord,
        source: &Table,
        partition_id: f64,
        started: &mut StartedCopies,
        resend_after: Option<Duration>,
    ) -> ClusterResult<()> {
        let Some(assignment) = source.assignments.get(partition_id) else {
            return Ok(());
        };
        let Some(primary) = assignment.primary.as_deref() else {
            return Ok(());
        };
        if let Some(sent) = started.get(&partition_key(partition_id))
            && sent.primary_term == assignment.primary_term
            && resend_after.is_none_or(|after| sent.sent_at.elapsed() < after)
        {
            return Ok(());
        }
        self.send_reshard_start(index_name, record, source, partition_id, primary)
            .await?;
        started.insert(
            partition_key(partition_id),
            StartedCopy {
                primary_term: assignment.primary_term,
                sent_at: Instant::now(),
            },
        );
        Ok(())
    }

    pub(super) async fn send_reshard_cutover(
        &self,
        index_name: &str,
        record: &RebalanceRecord,
        partition_id: f64,
        primary: &str,
        action: &str,
    ) -> ClusterResult<f64> {
        let mut payload = Map::with_capacity(4);
        payload.insert("indexName", Value::String(index_name.to_string()));
        payload.insert("jobId", Value::String(record.job_id.clone()));
        payload.insert("partitionId", Value::Number(partition_id));
        payload.insert("action", Value::String(action.to_string()));
        let reply = self
            .send_to_primary(
                primary,
                message_types::CLUSTER_RESHARD_CUTOVER,
                index_name,
                partition_id,
                payload,
            )
            .await?;
        match reply.get("lastSeqNo") {
            Some(Value::Number(last)) if last.is_finite() && last.fract() == 0.0 && *last >= 0.0 => {
                Ok(*last)
            }
            _ => Err(ClusterError::new(
                codes::ALLOCATION_FAILED,
                format!(
                    "Node '{primary}' answered the cutover of partition {partition_id} of index '{index_name}' without a sequence number"
                ),
            )
            .with_detail("indexName", Value::String(index_name.to_string()))
            .with_detail("partitionId", Value::Number(partition_id))
            .with_detail("primaryNodeId", Value::String(primary.to_string()))),
        }
    }

    pub(super) async fn lift_every_block(
        self: &Arc<Self>,
        index_name: &str,
        record: &RebalanceRecord,
    ) -> ClusterResult<()> {
        let Some(source) = stored_table(self.coordinator(), &record.source_generation).await?
        else {
            return Ok(());
        };
        let mut lifts = JoinSet::new();
        for (partition_id, assignment) in source.assignments.iter() {
            let Some(primary) = assignment.primary.clone() else {
                continue;
            };
            let inner = Arc::clone(self);
            let index_name = index_name.to_string();
            let record = record.clone();
            lifts.spawn(async move {
                let _ = inner
                    .send_reshard_cutover(&index_name, &record, partition_id, &primary, LIFT)
                    .await;
            });
        }
        while lifts.join_next().await.is_some() {}
        Ok(())
    }
}
