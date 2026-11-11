use std::cmp::Ordering;
use std::sync::Arc;

use super::checkpoint_segments::SegmentWriter;
use super::compaction::{Listed, WindowMerge, merge_window};
use super::constants::{
    REMOVED_DOCUMENT_REWRITE_BYTES_PER_CHECKPOINT, REWRITE_ABOVE_REMOVED_DOCUMENT_PERCENT,
};
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

fn chosen_rewrites(listed: &[Listed<'_>], mut held: u64, mut removed: u64) -> Vec<usize> {
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
    let mut rewritten_bytes = 0u64;
    for candidate in candidates {
        if !exceeds_removed_share(removed, held) {
            break;
        }
        let total = rewritten_bytes.saturating_add(candidate.bytes);
        if !chosen.is_empty() && total > REMOVED_DOCUMENT_REWRITE_BYTES_PER_CHECKPOINT {
            continue;
        }
        chosen.push(candidate.at);
        rewritten_bytes = total;
        held = held.saturating_sub(candidate.removed);
        removed = removed.saturating_sub(candidate.removed);
    }
    chosen.sort_unstable();
    chosen
}

/// Rewrites the segments of `listed` that free the most bytes, each into one segment that holds its live
/// documents, while the partition's removed share exceeds the rewrite threshold and the checkpoint's rewrite budget
/// allows, and returns the rewrites that replace them in memory once the checkpoint commits.
///
/// The share compares the documents that each listed segment holds with the ones that its in-memory segment still
/// counts as live, so a partition without removals reads no segment.
pub(super) fn rewrite_removed_documents(
    segments: &mut SegmentWriter<'_, '_>,
    index: &IndexState,
    partitions: &[Arc<Partition>],
    listed: &mut Vec<Listed<'_>>,
    next_id: &mut u64,
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
    for at in chosen_rewrites(listed, held, removed).into_iter().rev() {
        let rewrite = merge_window(segments, index, partitions, listed, at..at + 1, *next_id)?;
        *next_id += 1;
        rewrites.push(rewrite);
    }
    Ok(rewrites)
}
