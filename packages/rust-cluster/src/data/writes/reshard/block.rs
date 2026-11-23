use narsil::{ErrorCode, Value};

use super::super::PrimaryWrites;
use crate::error::{ClusterError, ClusterResult};
use crate::rebalance::{RebalancePhase, is_hidden_generation, read_rebalance_record};

pub(super) fn rebalancing_backpressure(index_name: &str, partition_id: u32) -> ClusterError {
    ClusterError::new(
        ErrorCode::PARTITION_REBALANCING_BACKPRESSURE.as_str(),
        format!(
            "Partition {partition_id} of index '{index_name}' refuses writes while its index moves to a new partition count"
        ),
    )
    .with_detail("indexName", Value::from(index_name))
    .with_detail("partitionId", Value::from(partition_id))
}

impl PrimaryWrites {
    pub(super) async fn public_name_of(&self, index_name: &str) -> ClusterResult<Option<String>> {
        if !is_hidden_generation(index_name) {
            return Ok(Some(index_name.to_string()));
        }
        if let Some(known) = self
            .reshard
            .with(|held| held.public_names.get(index_name).cloned())
        {
            return Ok(Some(known));
        }
        for name in self.coordinator.list_schemas().await? {
            if is_hidden_generation(&name) {
                continue;
            }
            let served = self.view.read(&name).await?;
            if served.and_then(|table| table.generation).as_deref() == Some(index_name) {
                self.reshard.with(|held| {
                    held.public_names
                        .insert(index_name.to_string(), name.clone())
                });
                return Ok(Some(name));
            }
        }
        Ok(None)
    }

    pub(super) async fn reconcile_reshard_block(
        &self,
        public_name: &str,
        source_generation: &str,
        partition_id: u32,
    ) -> ClusterResult<()> {
        let key = (source_generation.to_string(), partition_id);
        let marker = self.reshard.with(|held| held.next_marker);
        let record = read_rebalance_record(&self.coordinator, public_name).await?;
        if let Some(record) = &record
            && record.source_generation == source_generation
            && record.phase == RebalancePhase::Cutover
        {
            self.reshard.with(|held| {
                if !held.blocks.contains_key(&key) {
                    held.set_block(source_generation, &record.job_id, partition_id);
                }
            });
            return Ok(());
        }
        let Some(block) = self.reshard.with(|held| held.blocks.get(&key).cloned()) else {
            return Ok(());
        };
        if block.marker > marker {
            return Ok(());
        }
        if record.is_none() {
            let served = self
                .view
                .read(public_name)
                .await?
                .and_then(|table| table.generation);
            if served.is_some_and(|served| served != source_generation) {
                return Ok(());
            }
        }
        self.reshard.with(|held| {
            if held
                .blocks
                .get(&key)
                .is_some_and(|held| held.marker == block.marker)
            {
                held.blocks.remove(&key);
            }
        });
        Ok(())
    }

    async fn check_new_term(&self, index_name: &str, partition_id: u32, primary_term: u64) {
        self.reshard.with(|held| {
            held.checked_terms
                .insert((index_name.to_string(), partition_id), primary_term)
        });
        if let Ok(Some(public_name)) = self.public_name_of(index_name).await {
            let _ = self
                .reconcile_reshard_block(&public_name, index_name, partition_id)
                .await;
        }
    }

    pub(in crate::data::writes) async fn assert_reshard_open(
        &self,
        index_name: &str,
        partition_id: u32,
        primary_term: u64,
    ) -> ClusterResult<()> {
        let key = (index_name.to_string(), partition_id);
        let checked = self
            .reshard
            .with(|held| held.checked_terms.get(&key).copied());
        if checked != Some(primary_term) {
            self.check_new_term(index_name, partition_id, primary_term)
                .await;
        }
        if self.reshard.with(|held| held.blocks.contains_key(&key)) {
            return Err(rebalancing_backpressure(index_name, partition_id));
        }
        Ok(())
    }
}
