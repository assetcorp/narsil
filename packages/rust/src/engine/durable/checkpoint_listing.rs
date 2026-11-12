use std::sync::Arc;

use super::checkpoint_segments::{
    SavedSegment, SegmentWriter, ids_held_earlier, joined_tombstones,
};
use super::compaction::{Listed, removed_ids};
use crate::engine::index::IndexState;
use crate::error::Result;
use crate::format::keyword_segment::KeywordSegment;
use crate::format::manifest::{PartitionCheckpoint, PartitionEntry, SegmentManifest};
use crate::index::merge::{freeze_segment, merge_segments};
use crate::index::partition::{Partition, PartitionSnapshot};
use crate::index::segment::{SegmentData, SegmentEntry};

/// Reports whether a partition holds no log record beyond the position that the previous checkpoint covered.
pub(super) fn unchanged_since(
    prior: Option<&SegmentManifest>,
    reached: Option<&PartitionCheckpoint>,
) -> bool {
    let (Some(prior), Some(reached)) = (prior, reached) else {
        return false;
    };
    prior.checkpoint.iter().any(|entry| {
        entry.partition_id == reached.partition_id && entry.last_seq_no == reached.last_seq_no
    })
}

fn frozen(entry: &SegmentEntry) -> bool {
    matches!(entry.data, SegmentData::Frozen(_))
}

/// Lists the segments of a partition with no change since the previous checkpoint as that checkpoint listed them,
/// each beside the in-memory segment that holds its documents, so that the checkpoint writes no segment for the
/// partition beyond a rewrite. Returns `None` where memory holds a segment that the listing lacks, or lacks a
/// listed segment that holds a document.
pub(super) fn listed_as_before<'s>(
    prior: &PartitionEntry,
    snapshot: &'s PartitionSnapshot,
) -> Option<Vec<Listed<'s>>> {
    let mut listed = Vec::with_capacity(prior.segments.len());
    for reference in &prior.segments {
        let source = snapshot
            .segments
            .iter()
            .find(|entry| frozen(entry) && entry.id == reference.id);
        if source.is_none() && reference.document_count > 0 {
            return None;
        }
        listed.push(Listed {
            reference: reference.clone(),
            source,
        });
    }
    let memory_is_listed = snapshot
        .segments
        .iter()
        .filter(|entry| entry.live_count() > 0)
        .all(|entry| {
            frozen(entry)
                && prior
                    .segments
                    .iter()
                    .any(|reference| reference.id == entry.id)
        });
    memory_is_listed.then_some(listed)
}

type PendingSegment<'s> = (u64, KeywordSegment, Vec<String>, Option<&'s SegmentEntry>);

/// Lists the segments of a changed partition: each in-memory segment that the previous checkpoint wrote, and a
/// new segment for every other one, the last of which carries a tombstone for each document that a listed
/// segment holds and the index no longer holds.
pub(super) fn listed_with_changes<'s>(
    segments: &mut SegmentWriter<'_, '_>,
    index: &IndexState,
    partitions: &[Arc<Partition>],
    snapshot: &'s PartitionSnapshot,
    prior: Option<&PartitionEntry>,
    next_id: &mut u64,
    saved: &mut Vec<SavedSegment>,
) -> Result<Vec<Listed<'s>>> {
    let prior_refs = prior.map_or(&[][..], |entry| entry.segments.as_slice());
    let mut listed: Vec<Listed<'s>> = Vec::new();
    let mut tombstones = Vec::new();
    let mut pending: Vec<PendingSegment<'s>> = Vec::new();
    let mut earlier: Vec<&SegmentEntry> = Vec::new();
    for entry in &snapshot.segments {
        if entry.live_count() == 0 {
            continue;
        }
        let kept = prior_refs
            .iter()
            .find(|reference| frozen(entry) && reference.id == entry.id);
        match kept {
            Some(reference) => {
                tombstones.extend(removed_ids(index, partitions, &[entry])?);
                for (id, payload, held, source) in pending.drain(..) {
                    let (written, written_saved) = segments.write(id, payload, held)?;
                    listed.push(Listed {
                        reference: written,
                        source,
                    });
                    saved.push(written_saved);
                }
                listed.push(Listed {
                    reference: reference.clone(),
                    source: Some(entry),
                });
            }
            None => {
                let payload = freeze_segment(entry, &index.schema)?;
                let held = if segments.pages_text {
                    ids_held_earlier(&earlier, &payload)?
                } else {
                    Vec::new()
                };
                pending.push((entry.id, payload, held, Some(entry)));
            }
        }
        earlier.push(entry);
    }
    if !tombstones.is_empty() && pending.is_empty() {
        pending.push((
            *next_id,
            merge_segments(&[], &index.schema)?,
            Vec::new(),
            None,
        ));
        *next_id += 1;
    }
    let last = pending.len().saturating_sub(1);
    for (at, (id, payload, held, source)) in pending.into_iter().enumerate() {
        let carried = if at == last {
            joined_tombstones(held, std::mem::take(&mut tombstones))
        } else {
            held
        };
        let (written, written_saved) = segments.write(id, payload, carried)?;
        listed.push(Listed {
            reference: written,
            source,
        });
        saved.push(written_saved);
    }
    Ok(listed)
}
