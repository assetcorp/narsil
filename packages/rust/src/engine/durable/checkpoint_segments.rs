use std::borrow::Cow;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use super::backing::{Backing, CheckpointTarget};
use crate::durability::files::TEMPORARY_MARK;
use crate::error::Result;
use crate::format::envelope::{Compression, pack};
use crate::format::keyword_segment::{
    KEYWORD_SEGMENT_ENVELOPE_VERSION, KeywordSegment, decode_keyword_segment,
    encode_keyword_segment,
};
use crate::format::layout::segment_key;
use crate::format::manifest::PartitionEntry;
use crate::format::manifest::SegmentRef;
use crate::format::manifest_refs::FileRef;
use crate::format::paged_segment::{PAGED_SEGMENT_ENVELOPE_VERSION, encode_paged_segment};
use crate::index::frozen::FrozenSegment;
use crate::index::merge::{merge_paged_segments, merge_segments};
use crate::index::paged::{PagedListing, open_paged_segment};
use crate::index::partition::PartitionSnapshot;
use crate::index::segment::{SegmentData, SegmentEntry};
use crate::schema::CompiledSchema;

static SCRATCH_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A segment that a checkpoint wrote from memory, which replaces its in-memory form once the checkpoint commits.
pub(super) struct SavedSegment {
    pub(super) id: u64,
    pub(super) frozen: Arc<FrozenSegment>,
    paged_file: Option<FileRef>,
}

impl SavedSegment {
    /// Replaces the in-memory form of a paged segment with one that reads its paged sections from the committed
    /// file, so that the index keeps only the resident sections in memory. The in-memory form stays where the
    /// file does not open.
    pub(super) fn read_from_file(&mut self, backing: &Backing) {
        let Some(file) = &self.paged_file else {
            return;
        };
        if let Ok(Some(frozen)) = reopened_paged(backing, file) {
            self.frozen = frozen;
        }
    }
}

/// The target that receives the segment files of one partition, and whether it writes them as paged segments.
pub(super) struct SegmentWriter<'w, 'a> {
    pub(super) writer: &'w mut CheckpointTarget<'a>,
    pub(super) index_name: &'w str,
    pub(super) partition_id: u32,
    pub(super) pages_text: bool,
}

impl SegmentWriter<'_, '_> {
    /// Writes `payload` as segment `id` with `tombstones`, and returns the manifest entry that lists the file with
    /// the frozen form that replaces the segment's in-memory form once the checkpoint commits.
    pub(super) fn write(
        &mut self,
        id: u64,
        mut payload: KeywordSegment,
        tombstones: Vec<String>,
    ) -> Result<(SegmentRef, SavedSegment)> {
        let tombstone_count = u32::try_from(tombstones.len()).unwrap_or(u32::MAX);
        let key = segment_key(self.index_name, self.partition_id, id);
        let document_count = payload.document_count;
        let (file, frozen, paged_file) = if self.pages_text {
            let file = encode_paged_segment(&payload, tombstones)?;
            let mut sink = self
                .writer
                .create_envelope(&key, PAGED_SEGMENT_ENVELOPE_VERSION)?;
            file.write_payload(&mut |bytes| sink.write_payload(bytes))?;
            let written = self.writer.finish_envelope(sink)?;
            (written.clone(), FrozenSegment::new(payload), Some(written))
        } else {
            payload.tombstones = tombstones;
            let encoded = encode_keyword_segment(&payload)?;
            let packed = pack(
                &encoded,
                KEYWORD_SEGMENT_ENVELOPE_VERSION,
                Compression::None,
                "keyword segment",
            )?;
            let written = self.writer.write_file(&key, &packed)?;
            let frozen = FrozenSegment::new(decode_keyword_segment(&encoded)?);
            (written, frozen, None)
        };
        let reference = SegmentRef {
            id,
            file,
            document_count,
            tombstone_count,
        };
        let saved = SavedSegment {
            id,
            frozen: Arc::new(frozen),
            paged_file,
        };
        Ok((reference, saved))
    }

    /// Merges the live documents of `entries` into segment `id` with `tombstones`, and returns the manifest entry
    /// that lists the file with the frozen form that replaces the merged segments once the checkpoint commits.
    ///
    /// A paged merge writes every section that grows with the text into scratch files beside the segment and
    /// assembles the file from them, so that it holds in memory only the per-document and per-token tables, and
    /// the frozen form reads its paged sections from the written file.
    pub(super) fn write_merge(
        &mut self,
        id: u64,
        entries: &[SegmentEntry],
        schema: &CompiledSchema,
        tombstones: Vec<String>,
    ) -> Result<(SegmentRef, SavedSegment)> {
        let key = segment_key(self.index_name, self.partition_id, id);
        let path = match self.pages_text {
            true => self.writer.path_of(&key)?,
            false => None,
        };
        let Some(path) = path else {
            return self.write(id, merge_segments(entries, schema)?, tombstones);
        };
        let tombstone_count = u32::try_from(tombstones.len()).unwrap_or(u32::MAX);
        let mut scratch = path.clone().into_os_string();
        scratch.push(format!(
            "{TEMPORARY_MARK}merge-{}-{}",
            std::process::id(),
            SCRATCH_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let mut merged = merge_paged_segments(entries, schema, tombstones, PathBuf::from(scratch))?;
        let document_count = merged.document_count();
        let mut sink = self
            .writer
            .create_envelope(&key, PAGED_SEGMENT_ENVELOPE_VERSION)?;
        merged.write_payload(&mut |bytes| sink.write_payload(bytes))?;
        drop(merged);
        let written = self.writer.finish_envelope(sink)?;
        let frozen = opened_paged(&written, path)?;
        let reference = SegmentRef {
            id,
            file: written,
            document_count,
            tombstone_count,
        };
        let saved = SavedSegment {
            id,
            frozen,
            paged_file: None,
        };
        Ok((reference, saved))
    }

    /// Writes every live document of `snapshot` into one new segment numbered `next_id`, as a checkpoint that
    /// replaces an earlier release's layout does, and returns the partition's manifest entry with the written
    /// segment.
    pub(super) fn rewrite_partition(
        &mut self,
        snapshot: &PartitionSnapshot,
        schema: &CompiledSchema,
        next_id: u64,
    ) -> Result<(PartitionEntry, Option<SavedSegment>)> {
        let mut entry = PartitionEntry {
            partition_id: self.partition_id,
            next_segment_id: next_id,
            segments: Vec::new(),
        };
        if snapshot.document_count() == 0 {
            return Ok((entry, None));
        }
        let (reference, saved) =
            self.write_merge(next_id, &snapshot.segments, schema, Vec::new())?;
        entry.next_segment_id = next_id + 1;
        entry.segments.push(reference);
        Ok((entry, Some(saved)))
    }
}

fn holds_copy(entry: &SegmentEntry, id: &str) -> Result<bool> {
    Ok(match &entry.data {
        SegmentData::Frozen(segment) => segment.ordinal_of(id)?.is_some(),
        SegmentData::Tail(tail) => tail.ordinal_of(id).is_some(),
    })
}

fn ids_of(payload: &KeywordSegment) -> impl Iterator<Item = &str> {
    payload.id_offsets.windows(2).filter_map(|pair| {
        let bytes = payload.ids.get(pair[0] as usize..pair[1] as usize)?;
        std::str::from_utf8(bytes).ok()
    })
}

fn held_earlier<'i>(
    earlier: &[&SegmentEntry],
    ids: impl Iterator<Item = Result<Cow<'i, str>>>,
) -> Result<Vec<String>> {
    let mut held = Vec::new();
    if earlier.is_empty() {
        return Ok(held);
    }
    for id in ids {
        let id = id?;
        for entry in earlier {
            if holds_copy(entry, &id)? {
                held.push(id.into_owned());
                break;
            }
        }
    }
    Ok(held)
}

/// Returns the IDs of `payload` that a segment in `earlier` holds a copy of, removed or not. A paged segment lists
/// them as tombstones, because a reader applies a paged segment's tombstones to the segments before it and leaves
/// the segment's own IDs unread.
pub(super) fn ids_held_earlier(
    earlier: &[&SegmentEntry],
    payload: &KeywordSegment,
) -> Result<Vec<String>> {
    held_earlier(earlier, ids_of(payload).map(|id| Ok(Cow::Borrowed(id))))
}

/// Returns the IDs of the live documents of `entries`, in the order that a merge of them numbers them, that a
/// segment in `earlier` holds a copy of, as `ids_held_earlier` returns them for the merged payload.
pub(super) fn live_ids_held_earlier(
    earlier: &[&SegmentEntry],
    entries: &[SegmentEntry],
) -> Result<Vec<String>> {
    let ids = entries.iter().flat_map(|entry| {
        entry
            .live_ordinals()
            .map(move |ordinal| entry.id_of(ordinal))
    });
    held_earlier(earlier, ids)
}

/// Joins two tombstone lists, keeping the first copy of each ID in the order that the lists give them.
pub(super) fn joined_tombstones(first: Vec<String>, second: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::with_capacity(first.len() + second.len());
    first
        .into_iter()
        .chain(second)
        .filter(|id| seen.insert(id.clone()))
        .collect()
}

fn opened_paged(file: &FileRef, path: PathBuf) -> Result<Arc<FrozenSegment>> {
    let listing = PagedListing {
        key: file.key.clone(),
        path,
        bytes: file.bytes,
        checksum: file.checksum,
    };
    let (mut resident, sections) = open_paged_segment(&listing)?;
    resident.tombstones = Vec::new();
    Ok(Arc::new(FrozenSegment::from_paged(resident, sections)))
}

fn reopened_paged(backing: &Backing, file: &FileRef) -> Result<Option<Arc<FrozenSegment>>> {
    let Some(path) = backing.path_of(&file.key)? else {
        return Ok(None);
    };
    opened_paged(file, path).map(Some)
}
