use std::sync::Arc;

use super::Narsil;
use crate::error::Result;
use crate::format::envelope::{Compression, pack};
use crate::format::keyword_segment::{
    KEYWORD_SEGMENT_ENVELOPE_VERSION, KeywordSegment, decode_keyword_segment,
    encode_keyword_segment,
};
use crate::index::frozen::FrozenSegment;
use crate::index::merge::{freeze_segment, merge_segments};
use crate::index::segment::{SegmentData, SegmentEntry};

/// Opens a frozen segment on the bytes that `payload` encodes to, so that every payload passes the decoder's checks
/// before a search reads it.
fn reopened(payload: &KeywordSegment) -> Result<FrozenSegment> {
    let bytes = encode_keyword_segment(payload)?;
    Ok(FrozenSegment::new(decode_keyword_segment(&bytes)?))
}

impl Narsil {
    /// Replaces every tail segment of every partition of `index` with a frozen segment of its live documents.
    #[doc(hidden)]
    pub fn freeze_tail_segments(&self, index: &str) -> Result<()> {
        let state = self.inner.open_index(index)?;
        let _writer = state.write_lock();
        for partition in state.partitions().iter() {
            partition.write(|snapshot| -> Result<()> {
                for entry in snapshot.segments.iter_mut() {
                    if !matches!(entry.data, SegmentData::Tail(_)) {
                        continue;
                    }
                    let frozen = reopened(&freeze_segment(entry, &state.schema)?)?;
                    *entry = SegmentEntry::new(entry.id, SegmentData::Frozen(Arc::new(frozen)));
                }
                Ok(())
            })?;
        }
        Ok(())
    }

    /// Replaces the segments of every partition of `index` with one frozen segment of their live documents.
    #[doc(hidden)]
    pub fn merge_partition_segments(&self, index: &str) -> Result<()> {
        let state = self.inner.open_index(index)?;
        let _writer = state.write_lock();
        for partition in state.partitions().iter() {
            partition.write(|snapshot| -> Result<()> {
                if snapshot.segments.is_empty() {
                    return Ok(());
                }
                let frozen = reopened(&merge_segments(&snapshot.segments, &state.schema)?)?;
                let id = snapshot.allocate_segment_id();
                snapshot.segments =
                    vec![SegmentEntry::new(id, SegmentData::Frozen(Arc::new(frozen)))];
                Ok(())
            })?;
        }
        Ok(())
    }

    /// Returns, for each partition of `index`, the keyword segment file of each of its segments, oldest first,
    /// holding that segment's live documents.
    #[doc(hidden)]
    pub fn keyword_segment_files(&self, index: &str) -> Result<Vec<Vec<Vec<u8>>>> {
        let state = self.inner.open_index(index)?;
        let mut files = Vec::new();
        for partition in state.partitions().iter() {
            let snapshot = partition.snapshot();
            let mut segments = Vec::with_capacity(snapshot.segments.len());
            for entry in &snapshot.segments {
                let payload = encode_keyword_segment(&freeze_segment(entry, &state.schema)?)?;
                segments.push(pack(
                    &payload,
                    KEYWORD_SEGMENT_ENVELOPE_VERSION,
                    Compression::None,
                    "keyword segment",
                )?);
            }
            files.push(segments);
        }
        Ok(files)
    }
}
