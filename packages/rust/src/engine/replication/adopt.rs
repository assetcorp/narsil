use super::copy_state::{PartitionCopy, ReplicatedCopy};
use super::{CopyPosition, PartitionCopies};
use crate::config::{IndexConfig, MAX_PARTITIONS};
use crate::engine::index::IndexState;
use crate::engine::lifecycle::create_index;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::value::Value;

fn invalid(index: &str, message: String) -> NarsilError {
    NarsilError::new(ErrorCode::CONFIG_INVALID, message)
        .with_details([("indexName", Value::from(index))])
}

fn logged_positions(index: &IndexState) -> Result<Vec<PartitionCopy>> {
    let count = index.partitions().len();
    let mut reached = vec![0u64; count];
    if let Some(log) = index.log() {
        match log.log_store() {
            Some(store) => {
                for held in store.inner.logs_of(&index.name)? {
                    if let Some(slot) = reached.get_mut(held.partition_id() as usize) {
                        *slot = held.highest_appended()?;
                    }
                }
            }
            None => {
                for (partition, seq_no) in log.applied_seq_nos() {
                    if let Some(slot) = reached.get_mut(partition as usize) {
                        *slot = seq_no;
                    }
                }
            }
        }
    }
    Ok(reached
        .into_iter()
        .map(|seq_no| {
            let mut copy = PartitionCopy::default();
            if seq_no > 0 {
                let primary_term = crate::durability::constants::SINGLE_NODE_PRIMARY_TERM;
                copy.reach(CopyPosition {
                    seq_no: 1,
                    primary_term,
                });
                copy.reach(CopyPosition {
                    seq_no,
                    primary_term,
                });
            }
            copy
        })
        .collect())
}

impl PartitionCopies<'_> {
    /// Creates an empty cluster copy of an index with exactly `partition_count` partitions, stamped with the
    /// `uuid` that the cluster holds for the index.
    pub fn create_index(
        &self,
        index: &str,
        mut config: IndexConfig,
        uuid: &str,
        partition_count: u32,
    ) -> Result<()> {
        if uuid.is_empty() || partition_count == 0 || u64::from(partition_count) > MAX_PARTITIONS {
            return Err(invalid(
                index,
                format!(
                    "A cluster copy of index \"{index}\" needs a UUID and 1 to {MAX_PARTITIONS} partitions"
                ),
            ));
        }
        let mut partitions = config.partitions.unwrap_or_default();
        partitions.max_partitions = Some(u64::from(partition_count));
        config.partitions = Some(partitions);
        create_index(self.engine, index, config)?;
        self.adopt(index, uuid)
    }

    /// Stamps a local index that holds no UUID with the cluster's, and accepts one that holds the same UUID
    /// already. Fails with `CONFIG_INVALID` where the index holds another.
    pub fn adopt(&self, index: &str, uuid: &str) -> Result<()> {
        let writable = self.engine.writable_index(index)?;
        let state = writable.index();
        let _writer = state.lock_writes()?;
        if let Some(copy) = state.replicated_copy() {
            if copy.uuid == uuid {
                return Ok(());
            }
            return Err(invalid(
                index,
                format!("Index \"{index}\" is the copy of another index of the cluster"),
            ));
        }
        if uuid.is_empty() {
            return Err(invalid(
                index,
                format!("A cluster copy of index \"{index}\" needs a UUID"),
            ));
        }
        let partitions = logged_positions(state)?;
        if let Some(log) = state.log() {
            let mut metadata = log.metadata(state);
            metadata.set_index_uuid(uuid);
            log.write_recorded(metadata)?;
        }
        state.attach_replicated_copy(ReplicatedCopy::new(
            uuid.to_string(),
            Vec::new(),
            partitions,
        ));
        Ok(())
    }

    /// Records the partitions that the node holds, which a restart reads back before the node answers for them.
    pub fn record_held_partitions(&self, index: &str, partitions: &[u32]) -> Result<()> {
        let writable = self.engine.writable_index(index)?;
        let state = writable.index();
        let _writer = state.lock_writes()?;
        let copy = super::copy_of(state)?;
        let mut held = partitions.to_vec();
        held.sort_unstable();
        held.dedup();
        if held.iter().any(|&id| id as usize >= copy.partition_count()) {
            return Err(invalid(
                index,
                format!("Index \"{index}\" cannot hold a partition that it lacks"),
            ));
        }
        if held == copy.held() {
            return Ok(());
        }
        if let Some(log) = state.log() {
            let mut metadata = log.metadata(state);
            metadata.set_held_partitions(&held);
            log.write_recorded(metadata)?;
        }
        copy.hold(held);
        Ok(())
    }
}
