use std::collections::BTreeMap;
use std::sync::Arc;

use narsil::Value;
use tokio::time::Instant;

use super::WriteRouter;
use super::remote::unsent_after_window;
use super::write::{Attempted, PendingWrite, Refused};
use crate::data::{routed_partition, unassigned};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::payload::forward::ForwardRequest;

fn lost_metadata_during_batch(serving_name: &str, error: ClusterError) -> ClusterError {
    if error.code() != codes::INDEX_NOT_FOUND {
        return error;
    }
    ClusterError::new(
        codes::QUERY_ROUTING_FAILED,
        format!(
            "Index '{serving_name}' lost its cluster metadata while a batch waited for a new primary"
        ),
    )
    .with_detail("indexName", Value::from(serving_name))
}

impl WriteRouter {
    async fn apply_here(
        &self,
        serving_name: &str,
        index_uuid: Option<String>,
        writes: &[PendingWrite],
    ) -> Vec<(usize, Attempted)> {
        let positions = writes.iter().map(|write| write.position);
        let Some(local) = &self.local else {
            let error = crate::node::not_ready(&self.node_id);
            return positions
                .map(|position| (position, Err(Refused::of(error.clone()))))
                .collect();
        };
        let request = ForwardRequest {
            index_name: serving_name.to_string(),
            index_uuid,
            operations: writes.iter().map(PendingWrite::forward_operation).collect(),
        };
        let outcomes = local.apply_client_writes(request).await;
        positions
            .zip(outcomes)
            .map(|(position, outcome)| (position, outcome.map_err(Refused::from_failure)))
            .collect()
    }

    pub(super) async fn attempt(
        self: Arc<Self>,
        serving_name: Arc<str>,
        writes: Vec<PendingWrite>,
        batch: bool,
        deadline: Instant,
    ) -> ClusterResult<Vec<(usize, Attempted)>> {
        let table = self.routable_table(&serving_name).await.map_err(|error| {
            if batch {
                lost_metadata_during_batch(&serving_name, error)
            } else {
                error
            }
        })?;
        let partition_count = table.assignments.len();
        let mut outcomes = Vec::with_capacity(writes.len());
        let mut here = Vec::new();
        let mut remote: BTreeMap<String, Vec<PendingWrite>> = BTreeMap::new();
        for write in writes {
            let partition_id = routed_partition(write.document_id(), partition_count);
            let primary = table
                .assignments
                .get(f64::from(partition_id))
                .and_then(|assignment| assignment.primary.clone());
            match primary {
                None => outcomes.push((
                    write.position,
                    Err(Refused::of(unassigned(&serving_name, partition_id))),
                )),
                Some(primary) if primary == self.node_id => here.push(write),
                Some(primary) => remote.entry(primary).or_default().push(write),
            }
        }
        if !here.is_empty() {
            let applied = if Instant::now() < deadline {
                self.apply_here(&serving_name, table.index_uuid.clone(), &here)
                    .await
            } else {
                unsent_after_window(&serving_name, &here)
            };
            outcomes.extend(applied);
        }
        for (primary, forwarded) in remote {
            let answered = self
                .forward_to(
                    &serving_name,
                    table.index_uuid.as_deref(),
                    &primary,
                    &forwarded,
                    deadline,
                )
                .await;
            outcomes.extend(answered);
        }
        Ok(outcomes)
    }
}
