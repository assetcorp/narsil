use std::borrow::Cow;

use super::work::MeteredWork;
use crate::engine::index::IndexState;
use crate::error::Result;
use crate::filters::CompiledFilter;
use crate::filters::source::is_empty_bits;
use crate::index::partition::PartitionSnapshot;
use crate::index::segment::SegmentEntry;
use crate::pattern::{PatternScratch, WorkMeter};
use crate::value::Value;

/// What one search carries into every partition that it reads: its filter, checked against the schema and compiled
/// once, and the meter that counts the work of its pattern tests and phrases against the engine's cap.
pub(crate) struct QueryScope {
    filter: Option<CompiledFilter>,
    meter: WorkMeter,
}

/// The bitset of the live ordinals that a filter accepts in each segment of one partition, in segment order.
pub(crate) struct PartitionFilter {
    pub(crate) segments: Vec<Vec<u32>>,
}

impl PartitionFilter {
    /// Returns true where the filter accepts no live document of the partition.
    pub(crate) fn accepts_nothing(&self) -> bool {
        self.segments.iter().all(|bits| is_empty_bits(bits))
    }
}

fn for_each_ordinal(bits: &[u32], mut visit: impl FnMut(u32) -> Result<()>) -> Result<()> {
    for (word_at, &word) in bits.iter().enumerate() {
        let mut word = word;
        while word != 0 {
            visit(word_at as u32 * 32 + word.trailing_zeros())?;
            word &= word - 1;
        }
    }
    Ok(())
}

impl QueryScope {
    /// Checks `filters` against the index schema and compiles it, raising the filter error codes of every Narsil
    /// engine for a malformed filter, and starts a meter that allows `work_cap` units.
    pub(crate) fn new(
        index: &IndexState,
        filters: Option<&Value>,
        work_cap: i64,
    ) -> Result<QueryScope> {
        let filter = match filters {
            None | Some(Value::Null) => None,
            Some(filters) => Some(CompiledFilter::new(filters, &index.schema)?),
        };
        Ok(QueryScope {
            filter,
            meter: WorkMeter::new(work_cap),
        })
    }

    /// Returns true where the search carries a filter.
    pub(crate) fn filters(&self) -> bool {
        self.filter.is_some()
    }

    /// Returns the phrase work of the search, counted against the meter of its pattern tests.
    pub(crate) fn phrase_work(&self) -> MeteredWork<'_> {
        MeteredWork::new(&self.meter)
    }

    /// Returns the bitset of the live ordinals of `entry` that the filter accepts, or `None` without a filter.
    pub(crate) fn segment_bits(
        &self,
        entry: &SegmentEntry,
        scratch: &mut PatternScratch,
    ) -> Result<Option<Vec<u32>>> {
        match &self.filter {
            None => Ok(None),
            Some(filter) => filter
                .evaluate_segment(entry, &self.meter, scratch)
                .map(Some),
        }
    }

    /// Returns the filter's bitset over each segment of `snapshot`, or `None` without a filter.
    pub(crate) fn partition_filter(
        &self,
        snapshot: &PartitionSnapshot,
    ) -> Result<Option<PartitionFilter>> {
        if self.filter.is_none() {
            return Ok(None);
        }
        let mut scratch = PatternScratch::default();
        let mut segments = Vec::with_capacity(snapshot.segments.len());
        for entry in &snapshot.segments {
            segments.push(self.segment_bits(entry, &mut scratch)?.unwrap_or_default());
        }
        Ok(Some(PartitionFilter { segments }))
    }

    /// Returns the IDs of the live documents of `snapshots` that the filter accepts, or `None` without a filter.
    pub(crate) fn matched_ids<'s>(
        &self,
        snapshots: &'s [std::sync::Arc<PartitionSnapshot>],
    ) -> Result<Option<Vec<Cow<'s, str>>>> {
        if self.filter.is_none() {
            return Ok(None);
        }
        let mut scratch = PatternScratch::default();
        let mut ids = Vec::new();
        for snapshot in snapshots {
            for entry in &snapshot.segments {
                let Some(bits) = self.segment_bits(entry, &mut scratch)? else {
                    continue;
                };
                for_each_ordinal(&bits, |ordinal| {
                    if !entry.is_removed(ordinal) {
                        ids.push(entry.id_of(ordinal)?);
                    }
                    Ok(())
                })?;
            }
        }
        Ok(Some(ids))
    }
}
