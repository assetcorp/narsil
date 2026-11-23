use std::sync::Arc;

use narsil::replication::{NodeMemoryReading, PartitionCopies};

use super::copies::LocalCopies;
use super::role::DataRole;
use crate::error::ClusterResult;
use crate::memory::{
    HeldIndexSizes, MemorySource, PartitionSize, PartitionSizesSource, held_partition_sizes,
};

impl DataRole {
    pub(crate) fn memory_sources(&self) -> ClusterResult<(MemorySource, PartitionSizesSource)> {
        let copies = self.settled_copies()?;
        let measured = Arc::clone(&copies);
        let measure: MemorySource = Arc::new(move || measured.measure_memory());
        let sizes: PartitionSizesSource = Arc::new(move || copies.partition_sizes());
        Ok((measure, sizes))
    }
}

impl LocalCopies {
    fn measure_memory(&self) -> Option<NodeMemoryReading> {
        PartitionCopies::new(&self.engine).measure_memory()
    }

    pub(super) fn reserved_memory_bytes(&self) -> u64 {
        PartitionCopies::new(&self.engine).reserved_memory_bytes()
    }

    fn held_sizes_of(&self, index_name: &str) -> Option<Vec<PartitionSize>> {
        let held = self.held_partition_ids(index_name).ok()?;
        if held.is_empty() {
            return Some(Vec::new());
        }
        let partitions = self.engine.get_partition_stats(index_name).ok()?;
        let index_bytes = self
            .engine
            .get_stats(index_name)
            .ok()?
            .estimated_memory_bytes;
        Some(held_partition_sizes(HeldIndexSizes {
            index_name: index_name.to_string(),
            held,
            index_bytes,
            partitions: partitions
                .into_iter()
                .filter_map(|partition| {
                    let partition_id = u32::try_from(partition.partition_id).ok()?;
                    Some((
                        partition_id,
                        partition.estimated_memory_bytes,
                        partition.document_count,
                    ))
                })
                .collect(),
        }))
    }

    fn partition_sizes(&self) -> Vec<PartitionSize> {
        let mut sizes = Vec::new();
        for index in self.engine.list_indexes() {
            if let Some(held) = self.held_sizes_of(&index.name) {
                sizes.extend(held);
            }
        }
        sizes
    }
}
