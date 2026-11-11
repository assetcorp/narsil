use std::cmp::Ordering;
use std::sync::Arc;

use super::checkpoint_segments::SegmentWriter;
use super::compaction::{Listed, WindowMerge, merge_window};
use super::constants::REWRITE_ABOVE_REMOVED_DOCUMENT_PERCENT;
use crate::engine::index::IndexState;
use crate::error::Result;
use crate::index::partition::Partition;
use crate::index::segment::{SegmentData, SegmentEntry};

const PERCENT: u128 = 100;

fn exceeds_removed_share(removed: u64, held: u64) -> bool {
    held > 0
        && u128::from(removed) * PERCENT
            > u128::from(held) * u128::from(REWRITE_ABOVE_REMOVED_DOCUMENT_PERCENT)
}

fn removed_in(listed: &Listed<'_>) -> u64 {
    listed.source.map_or(0, |source| {
        u64::from(
            listed
                .reference
                .document_count
                .saturating_sub(source.live_count()),
        )
    })
}

fn counted_in_memory(entry: &SegmentEntry) -> Option<(u64, u64)> {
    let SegmentData::Frozen(_) = entry.data else {
        return None;
    };
    let live = entry.live_count();
    if live == 0 {
        return None;
    }
    let held = entry.capacity();
    Some((u64::from(held), u64::from(held.saturating_sub(live))))
}

/// Reports whether a partition of `index` holds a removed share above the rewrite threshold in the segments that
/// its checkpoints wrote, from the counters of its in-memory segments alone.
pub(super) fn removed_share_exceeded(index: &IndexState) -> bool {
    index.partitions().iter().any(|partition| {
        let snapshot = partition.snapshot();
        let (held, removed) = snapshot.segments.iter().filter_map(counted_in_memory).fold(
            (0u64, 0u64),
            |(held, removed), (entry_held, entry_removed)| {
                (
                    held.saturating_add(entry_held),
                    removed.saturating_add(entry_removed),
                )
            },
        );
        exceeds_removed_share(removed, held)
    })
}

struct Candidate {
    at: usize,
    bytes: u64,
    documents: u64,
    removed: u64,
}

impl Candidate {
    fn frees_more_than(&self, other: &Candidate) -> Ordering {
        let mine = u128::from(self.bytes) * u128::from(self.removed) * u128::from(other.documents);
        let theirs =
            u128::from(other.bytes) * u128::from(other.removed) * u128::from(self.documents);
        theirs.cmp(&mine)
    }
}

/// The bytes of existing segment files that one checkpoint may rewrite beyond the first rewritten segment of each
/// partition, and the bytes that its rewrites have taken so far.
pub(super) struct RewriteBudget {
    limit: u64,
    spent: u64,
}

impl RewriteBudget {
    pub(super) fn new(limit: u64) -> RewriteBudget {
        RewriteBudget { limit, spent: 0 }
    }
}

fn chosen_rewrites(
    listed: &[Listed<'_>],
    mut held: u64,
    mut removed: u64,
    budget: &mut RewriteBudget,
) -> Vec<usize> {
    let mut candidates: Vec<Candidate> = listed
        .iter()
        .enumerate()
        .filter(|(_, listed)| {
            listed
                .source
                .is_some_and(|source| matches!(source.data, SegmentData::Frozen(_)))
        })
        .map(|(at, listed)| Candidate {
            at,
            bytes: listed.reference.file.bytes,
            documents: u64::from(listed.reference.document_count),
            removed: removed_in(listed),
        })
        .filter(|candidate| candidate.removed > 0)
        .collect();
    candidates.sort_by(Candidate::frees_more_than);
    let mut chosen = Vec::new();
    for candidate in candidates {
        if !exceeds_removed_share(removed, held) {
            break;
        }
        let total = budget.spent.saturating_add(candidate.bytes);
        if !chosen.is_empty() && total > budget.limit {
            continue;
        }
        chosen.push(candidate.at);
        budget.spent = total;
        held = held.saturating_sub(candidate.removed);
        removed = removed.saturating_sub(candidate.removed);
    }
    chosen.sort_unstable();
    chosen
}

/// Rewrites the segments of `listed` that free the most bytes, each into one segment that holds its live
/// documents, while the partition's removed share exceeds the rewrite threshold, and returns the rewrites that
/// replace them in memory once the checkpoint commits. The first segment of a partition is always rewritten, and
/// each further one only while `budget` allows it, so every partition above the threshold shrinks in every
/// checkpoint.
///
/// The share compares the documents that each listed segment holds with the ones that its in-memory segment still
/// counts as live, so a partition without removals reads no segment.
pub(super) fn rewrite_removed_documents(
    segments: &mut SegmentWriter<'_, '_>,
    index: &IndexState,
    partitions: &[Arc<Partition>],
    listed: &mut Vec<Listed<'_>>,
    next_id: &mut u64,
    budget: &mut RewriteBudget,
) -> Result<Vec<WindowMerge>> {
    let held = listed.iter().fold(0u64, |total, listed| {
        total.saturating_add(u64::from(listed.reference.document_count))
    });
    let removed = listed.iter().fold(0u64, |total, listed| {
        total.saturating_add(removed_in(listed))
    });
    if !exceeds_removed_share(removed, held) {
        return Ok(Vec::new());
    }
    let mut rewrites = Vec::new();
    let chosen = chosen_rewrites(listed, held, removed, budget);
    for at in chosen.into_iter().rev() {
        let rewrite = merge_window(segments, index, partitions, listed, at..at + 1, *next_id)?;
        *next_id += 1;
        rewrites.push(rewrite);
    }
    Ok(rewrites)
}
