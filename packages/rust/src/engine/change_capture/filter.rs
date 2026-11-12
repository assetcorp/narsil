use std::sync::Arc;

use crate::engine::index::IndexState;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::filters::{CompiledFilter, Filter};
use crate::index::derived::KeptColumns;
use crate::index::segment::{SegmentData, SegmentEntry, bit_is_set};
use crate::index::tail::{Appended, TailSegment};
use crate::pattern::{SearchLimits, WorkMeter};
use crate::value::Map;

pub(super) struct ChangeFilter {
    compiled: CompiledFilter,
}

impl ChangeFilter {
    pub(super) fn new(filter: &Filter, index: &IndexState) -> Result<ChangeFilter> {
        Ok(ChangeFilter {
            compiled: CompiledFilter::new(&filter.to_value(), &index.schema)?,
        })
    }

    pub(super) fn matches(
        &self,
        index: &IndexState,
        limits: &SearchLimits,
        document: &Map,
    ) -> Result<bool> {
        let mut tail = TailSegment::new(index.track_positions, &KeptColumns::default());
        let indexed = index.index_document(document)?;
        if let Appended::SegmentFull(_) =
            tail.append(String::new(), Arc::new(document.clone()), indexed)?
        {
            return Err(NarsilError::new(
                ErrorCode::INTERNAL_ERROR,
                format!(
                    "Index \"{}\" holds a document that the engine cannot index alone to test a change filter",
                    index.name
                ),
            ));
        }
        let entry = SegmentEntry::new(0, SegmentData::Tail(Arc::new(tail)));
        let matched = self
            .compiled
            .evaluate_segment(&entry, &WorkMeter::within(limits))?;
        Ok(bit_is_set(&matched, 0))
    }
}
