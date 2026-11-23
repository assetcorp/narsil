use super::super::PrimaryWrites;
use super::super::forward::routed_partition;
use super::block::rebalancing_backpressure;
use crate::allocator::Table;
use crate::error::{ClusterError, ClusterResult};
use crate::rebalance::is_hidden_generation;

pub(in crate::data::writes) struct BlockedName {
    index_name: String,
    blocked: Vec<u32>,
    partition_count: Option<usize>,
}

impl BlockedName {
    pub(in crate::data::writes) fn refusal(&self, document_id: &str) -> ClusterError {
        let first = self.blocked.first().copied().unwrap_or_default();
        let routed = self
            .partition_count
            .filter(|count| *count > 0)
            .map_or(first, |count| routed_partition(document_id, count));
        let partition_id = if self.blocked.contains(&routed) {
            routed
        } else {
            first
        };
        rebalancing_backpressure(&self.index_name, partition_id)
    }
}

impl PrimaryWrites {
    fn blocked_partitions_of(&self, index_name: &str) -> Vec<u32> {
        let mut blocked: Vec<u32> = self.reshard.with(|held| {
            held.blocks
                .iter()
                .filter(|((name, _), _)| name == index_name)
                .map(|(_, block)| block.partition_id)
                .collect()
        });
        blocked.sort_unstable();
        blocked
    }

    async fn serving_generation_of(
        &self,
        index_name: &str,
        table: Option<Table>,
    ) -> ClusterResult<String> {
        if let Some(generation) = table.and_then(|table| table.generation) {
            return Ok(generation);
        }
        if !is_hidden_generation(index_name) {
            return Ok(index_name.to_string());
        }
        let Some(public_name) = self.public_name_of(index_name).await? else {
            return Ok(index_name.to_string());
        };
        Ok(self
            .view
            .read(&public_name)
            .await?
            .and_then(|table| table.generation)
            .unwrap_or(public_name))
    }

    pub(in crate::data::writes) async fn name_of_forwarded_write(
        &self,
        index_name: &str,
    ) -> ClusterResult<Result<String, BlockedName>> {
        let table = self.view.read(index_name).await?;
        if table
            .as_ref()
            .is_some_and(|table| !table.assignments.is_empty())
        {
            return Ok(Ok(index_name.to_string()));
        }
        let blocked = self.blocked_partitions_of(index_name);
        if blocked.is_empty() {
            return Ok(Ok(self.serving_generation_of(index_name, table).await?));
        }
        let held_name = index_name.to_string();
        let partition_count = self
            .on_copies(move |copies| {
                Ok(copies
                    .engine
                    .get_stats(&held_name)
                    .ok()
                    .map(|stats| stats.partition_count))
            })
            .await?;
        Ok(Err(BlockedName {
            index_name: index_name.to_string(),
            blocked,
            partition_count,
        }))
    }
}
