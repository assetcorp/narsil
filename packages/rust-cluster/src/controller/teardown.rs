use std::sync::Arc;
use std::time::Duration;

use narsil::Value;

use super::metadata::index_metadata;
use super::table::stored_table;
use super::{Inner, lock};
use crate::allocator::{Assignments, Table};
use crate::constants::{TEARDOWN_CAS_ATTEMPTS, TEARDOWN_RETRY_DELAY_MS, TEARDOWN_RETRY_ROUNDS};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::transport::BoxFuture;

impl Inner {
    async fn serves_recreated_index(&self, table: &Table) -> ClusterResult<bool> {
        let Some(index_uuid) = &table.index_uuid else {
            return Ok(false);
        };
        let metadata = index_metadata(self.coordinator(), &table.index_name).await?;
        Ok(metadata.is_some_and(|metadata| metadata.index_uuid == *index_uuid))
    }

    fn tear_down_task(self: Arc<Self>, index_name: String, round: usize) -> BoxFuture<'static, ()> {
        Box::pin(async move {
            if let Err(error) = self.tear_down(&index_name, round).await {
                self.report(&index_name, &error);
            }
        })
    }

    fn schedule_teardown_retry(self: &Arc<Self>, index_name: &str, round: usize) {
        let sequence = self.next_sequence();
        let inner = Arc::clone(self);
        let owned_name = index_name.to_string();
        let mut state = lock(&self.state);
        if let Some((_, previous)) = state.teardowns.remove(index_name) {
            previous.abort();
        }
        let timer = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(TEARDOWN_RETRY_DELAY_MS)).await;
            {
                let mut state = lock(&inner.state);
                if state.teardowns.get(&owned_name).map(|(queued, _)| *queued) != Some(sequence) {
                    return;
                }
                state.teardowns.remove(&owned_name);
            }
            let task = Arc::clone(&inner).tear_down_task(owned_name.clone(), round);
            inner.schema_queues.enqueue(&owned_name, task);
        });
        state
            .teardowns
            .insert(index_name.to_string(), (sequence, timer));
    }

    pub(super) async fn tear_down(
        self: &Arc<Self>,
        index_name: &str,
        round: usize,
    ) -> ClusterResult<()> {
        for _ in 0..TEARDOWN_CAS_ATTEMPTS {
            if !self.is_active() {
                return Ok(());
            }
            let Some(current) = stored_table(self.coordinator(), index_name).await? else {
                return Ok(());
            };
            if self.serves_recreated_index(&current).await? || !self.is_active() {
                return Ok(());
            }
            if !current.assignments.is_empty() {
                let emptied = Table {
                    index_name: index_name.to_string(),
                    version: current.version + 1.0,
                    replication_factor: current.replication_factor,
                    assignments: Assignments::default(),
                    generation: None,
                    index_uuid: current.index_uuid.clone(),
                };
                let written = self
                    .coordinator()
                    .put_allocation_guarded(
                        index_name,
                        &emptied.to_stored(),
                        Some(current.version),
                        self.node_id(),
                        None,
                    )
                    .await?;
                if !written {
                    continue;
                }
                if !self.is_active() {
                    return Ok(());
                }
            }
            self.coordinator().delete_allocation(index_name).await?;
            return Ok(());
        }
        if round + 1 < TEARDOWN_RETRY_ROUNDS && self.is_active() {
            self.schedule_teardown_retry(index_name, round + 1);
            return Ok(());
        }
        Err(ClusterError::new(
            codes::ALLOCATION_FAILED,
            format!(
                "Teardown of the allocation for dropped index '{index_name}' lost every compare-and-set attempt"
            ),
        )
        .with_detail("indexName", Value::String(index_name.to_string()))
        .with_detail(
            "attempts",
            Value::Number((TEARDOWN_CAS_ATTEMPTS * TEARDOWN_RETRY_ROUNDS) as f64),
        ))
    }
}
