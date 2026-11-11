use std::sync::Arc;

use super::segment::SegmentEntry;
use crate::engine::SortMode;
use crate::error::Result;
use crate::ordering::{SortColumn, SortValues, TextRangeBounds, push_reduced, text_range};

const WORD_BITS: u32 = 32;

impl SegmentEntry {
    pub(crate) fn sort_column(&self, path: &str, mode: SortMode) -> Result<Arc<SortColumn>> {
        self.derived().sort_columns.column(
            |(held_path, held_mode)| held_path == path && *held_mode == mode,
            || (path.to_string(), mode),
            self.capacity() as usize,
            |column, range| {
                let stored = self.core_stored_values(path)?;
                let mut values = SortValues::default();
                for ordinal in range {
                    push_reduced(&stored, ordinal as u32, mode, &mut values)?;
                }
                column.append(&values)?;
                column.rebuild()
            },
        )
    }

    pub(crate) fn live_bits(&self) -> Vec<u32> {
        let capacity = self.capacity();
        let mut words = vec![0u32; capacity.div_ceil(WORD_BITS).max(1) as usize];
        for ordinal in 0..capacity {
            if !self.is_removed(ordinal) {
                words[(ordinal / WORD_BITS) as usize] |= 1 << (ordinal % WORD_BITS);
            }
        }
        words
    }

    pub(crate) fn text_range(
        &self,
        path: &str,
        bounds: &TextRangeBounds<'_>,
        live: &[u32],
    ) -> Result<Vec<u32>> {
        let column = self.sort_column(path, SortMode::Min)?;
        text_range(&column.view(), bounds, live)
    }
}
