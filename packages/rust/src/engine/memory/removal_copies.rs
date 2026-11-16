use std::collections::HashSet;
use std::sync::Arc;

use crate::engine::index::IndexState;
use crate::index::partition::{Partition, PartitionSnapshot};
use crate::index::segment::SegmentData;
use crate::index::tail_growth::snapshot_is_shared;

#[derive(Default)]
pub(crate) struct RemovalCopies {
    bytes_before: Vec<usize>,
    last_tail_copied_at: Vec<Option<usize>>,
}

struct HeldSnapshot {
    snapshot: Arc<PartitionSnapshot>,
    shared: bool,
}

fn copies_anything(held: &[HeldSnapshot]) -> bool {
    held.iter().any(|partition| {
        partition
            .snapshot
            .segments
            .iter()
            .any(|entry| entry.removal_copy_bytes(partition.shared) > 0)
    })
}

impl RemovalCopies {
    pub(crate) fn of(
        index: &IndexState,
        partitions: &[Arc<Partition>],
        replaced: &[String],
    ) -> RemovalCopies {
        let held: Vec<HeldSnapshot> = partitions
            .iter()
            .map(|partition| {
                let snapshot = partition.snapshot();
                let shared = snapshot_is_shared(&snapshot);
                HeldSnapshot { snapshot, shared }
            })
            .collect();
        if replaced.is_empty() || !copies_anything(&held) {
            return RemovalCopies::default();
        }
        let mut copies = RemovalCopies {
            bytes_before: Vec::with_capacity(replaced.len() + 1),
            last_tail_copied_at: vec![None; held.len()],
        };
        let mut counted: HashSet<(usize, u64)> = HashSet::new();
        let mut bytes = 0usize;
        copies.bytes_before.push(bytes);
        for (position, id) in replaced.iter().enumerate() {
            let found = index.routed_first(id, held.len()).find_map(|at| {
                let partition = held.get(at)?;
                let (segment, _) = partition.snapshot.locate(id).ok().flatten()?;
                Some((at, partition, segment))
            });
            if let Some((at, partition, segment)) = found
                && let Some(entry) = partition.snapshot.segments.get(segment)
                && counted.insert((at, entry.id))
            {
                let copied = entry.removal_copy_bytes(partition.shared);
                bytes = bytes.saturating_add(copied);
                let last = segment + 1 == partition.snapshot.segments.len();
                if copied > 0
                    && last
                    && matches!(entry.data, SegmentData::Tail(_))
                    && let Some(slot) = copies.last_tail_copied_at.get_mut(at)
                {
                    slot.get_or_insert(position);
                }
            }
            copies.bytes_before.push(bytes);
        }
        copies
    }

    pub(crate) fn bytes(&self, documents: usize) -> usize {
        let at = documents.min(self.bytes_before.len().saturating_sub(1));
        self.bytes_before.get(at).copied().unwrap_or(0)
    }

    pub(crate) fn copies_last_tail(&self, partition: usize, documents: usize) -> bool {
        self.last_tail_copied_at
            .get(partition)
            .copied()
            .flatten()
            .is_some_and(|position| position < documents)
    }
}
