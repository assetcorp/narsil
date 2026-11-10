use std::ops::Range;

use super::checkpoint_segments::{
    SavedSegment, SegmentWriter, joined_tombstones, live_ids_held_earlier,
};
use super::constants::{
    COMPACTION_LARGEST_MERGED_DOCUMENT_COUNT, MERGED_SEGMENT_GROWTH_PERCENT,
    MERGED_SEGMENT_TARGET_BYTES, SEGMENT_FILE_FRAMING_SLACK_BYTES,
};
use crate::engine::index::IndexState;
use crate::error::Result;
use crate::format::envelope::MAX_FILE_BYTES;
use crate::format::manifest::SegmentRef;
use crate::index::partition::Partition;
use crate::index::segment::SegmentEntry;
use std::sync::Arc;

/// One segment that a checkpoint lists for a partition, with the in-memory segment that holds its documents, or
/// `None` for a segment that carries tombstones alone.
pub(super) struct Listed<'s> {
    pub(super) reference: SegmentRef,
    pub(super) source: Option<&'s SegmentEntry>,
}

/// A run of adjacent segments that a checkpoint merged into one, which replaces them in memory once it commits.
pub(super) struct WindowMerge {
    pub(super) replaced: Vec<u64>,
    pub(super) saved: Option<SavedSegment>,
}

fn window_fits(refs: &[Listed<'_>], paged: bool) -> bool {
    let mut documents: u64 = 0;
    let mut bytes = SEGMENT_FILE_FRAMING_SLACK_BYTES;
    for listed in refs {
        documents = documents.saturating_add(u64::from(listed.reference.document_count));
        bytes = bytes.saturating_add(listed.reference.file.bytes);
    }
    if paged {
        return bytes.saturating_mul(MERGED_SEGMENT_GROWTH_PERCENT)
            <= MERGED_SEGMENT_TARGET_BYTES.saturating_mul(100);
    }
    documents <= COMPACTION_LARGEST_MERGED_DOCUMENT_COUNT && bytes <= MAX_FILE_BYTES
}

fn smallest_fitting_window(
    listed: &[Listed<'_>],
    length: usize,
    paged: bool,
) -> Option<Range<usize>> {
    let mut best: Option<(Range<usize>, u64)> = None;
    for start in 0..=listed.len().saturating_sub(length) {
        let window = start..start + length;
        let Some(refs) = listed.get(window.clone()) else {
            continue;
        };
        if !window_fits(refs, paged) {
            continue;
        }
        let bytes = refs
            .iter()
            .map(|listed| listed.reference.file.bytes)
            .fold(0, u64::saturating_add);
        if best.as_ref().is_none_or(|(_, least)| bytes < *least) {
            best = Some((window, bytes));
        }
    }
    best.map(|(window, _)| window)
}

/// Chooses the run of adjacent segments that a checkpoint merges once a partition lists more than `threshold`:
/// the longest run, up to the excess plus one, whose merged file stays within the size limits, and among runs
/// of that length the one with the fewest bytes.
pub(super) fn choose_window(
    listed: &[Listed<'_>],
    threshold: usize,
    paged: bool,
) -> Option<Range<usize>> {
    if listed.len() <= threshold || listed.len() < 2 {
        return None;
    }
    let wanted = (listed.len() - threshold + 1).min(listed.len());
    (2..=wanted)
        .rev()
        .find_map(|length| smallest_fitting_window(listed, length, paged))
}

/// Returns the IDs that the files of `earlier` hold and that the index no longer holds anywhere, which a later
/// segment of the partition must list as tombstones so that a reader drops them.
pub(super) fn removed_ids(
    index: &IndexState,
    partitions: &[Arc<Partition>],
    earlier: &[&SegmentEntry],
) -> Result<Vec<String>> {
    let mut removed = Vec::new();
    for entry in earlier {
        for ordinal in (0..entry.capacity()).filter(|&ordinal| entry.is_removed(ordinal)) {
            let id = entry.id_of(ordinal)?;
            if index.locate(partitions, &id)?.is_none() {
                removed.push(id.into_owned());
            }
        }
    }
    Ok(removed)
}

/// Merges the segments of `window` into one new segment `id` and puts its manifest entry in their place.
///
/// The merged segment carries a tombstone for every document that a segment before the window held and the index
/// no longer holds, because a reader applies a segment's tombstones only to the segments before it, and the
/// segments that carried those tombstones are among the merged ones.
pub(super) fn merge_window(
    segments: &mut SegmentWriter<'_, '_>,
    index: &IndexState,
    partitions: &[Arc<Partition>],
    listed: &mut Vec<Listed<'_>>,
    window: Range<usize>,
    id: u64,
) -> Result<WindowMerge> {
    let earlier: Vec<&SegmentEntry> = listed
        .get(..window.start)
        .unwrap_or_default()
        .iter()
        .filter_map(|listed| listed.source)
        .collect();
    let merged_inputs: Vec<SegmentEntry> = listed
        .get(window.clone())
        .unwrap_or_default()
        .iter()
        .filter_map(|listed| listed.source.cloned())
        .collect();
    let replaced = listed
        .get(window.clone())
        .unwrap_or_default()
        .iter()
        .map(|listed| listed.reference.id)
        .collect();
    let removed = if window.start == 0 {
        Vec::new()
    } else {
        removed_ids(index, partitions, &earlier)?
    };
    let held = if segments.pages_text {
        live_ids_held_earlier(&earlier, &merged_inputs)?
    } else {
        Vec::new()
    };
    let tombstones = joined_tombstones(held, removed);
    let holds_no_document = merged_inputs
        .iter()
        .all(|entry| entry.live_ordinals().next().is_none());
    if holds_no_document && tombstones.is_empty() {
        listed.drain(window);
        return Ok(WindowMerge {
            replaced,
            saved: None,
        });
    }
    let (reference, saved) = segments.write_merge(id, &merged_inputs, &index.schema, tombstones)?;
    listed.splice(
        window,
        std::iter::once(Listed {
            reference,
            source: None,
        }),
    );
    Ok(WindowMerge {
        replaced,
        saved: Some(saved),
    })
}
