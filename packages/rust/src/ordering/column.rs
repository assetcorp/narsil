use std::cmp::Ordering;

use super::constants::{MIN_SORT_ORDER_REBUILD_DIRTY, SORT_ORDER_REBUILD_LIVE_DIVISOR};
use super::native::{SortOrder, bitset_words, build_order, every_ordinal};
use super::values::{OwnedSortValue, SortValues};
use crate::error::Result;
use crate::ffi;

const MISSING_RANK: i32 = -1;
const COMPARED_PAIR: usize = 2;

#[derive(Clone, Default)]
pub(crate) struct SortColumn {
    current: SortValues,
    order: SortOrder,
    dirty: Vec<u32>,
    dirty_count: usize,
}

fn compare_through_core(
    left: &SortValues,
    at: usize,
    right: &SortValues,
    other: usize,
) -> Result<Ordering> {
    let mut pair = SortValues::default();
    pair.push(&left.value(at))?;
    pair.push(&right.value(other))?;
    let order = build_order(&pair, &every_ordinal(COMPARED_PAIR))?;
    Ok(order.ranks[0].cmp(&order.ranks[1]))
}

impl SortColumn {
    pub(crate) fn len(&self) -> usize {
        self.current.len()
    }

    pub(crate) fn append(&mut self, values: &SortValues) -> Result<()> {
        let start = self.current.len();
        self.current.append(values)?;
        self.dirty.resize(bitset_words(self.current.len()), 0);
        for ordinal in start..self.current.len() {
            self.dirty[ordinal / 32] |= 1 << (ordinal % 32);
        }
        self.dirty_count += values.len();
        Ok(())
    }

    pub(crate) fn rebuild(&mut self) -> Result<()> {
        self.order = build_order(&self.current, &every_ordinal(self.current.len()))?;
        self.dirty = vec![0; bitset_words(self.current.len())];
        self.dirty_count = 0;
        Ok(())
    }

    pub(crate) fn settle(&mut self, live_count: usize) -> Result<()> {
        let threshold =
            (live_count / SORT_ORDER_REBUILD_LIVE_DIVISOR).max(MIN_SORT_ORDER_REBUILD_DIRTY);
        match self.dirty_count > threshold {
            true => self.rebuild(),
            false => Ok(()),
        }
    }

    pub(crate) fn value(&self, ordinal: u32) -> OwnedSortValue {
        self.current.value(ordinal as usize)
    }

    pub(crate) fn view(&self) -> ffi::narsil_sort_column {
        ffi::narsil_sort_column {
            current: self.current.view(),
            values: self.order.values.view(),
            ranks: self.order.ranks.as_ptr(),
            rank_count: self.order.ranks.len(),
            ordered: self.order.ordered.as_ptr(),
            ordered_count: self.order.ordered.len(),
            dirty: self.dirty.as_ptr(),
            dirty_words: self.dirty.len(),
        }
    }

    pub(crate) fn anchor_rank(&self, anchor: &SortValues, at: usize) -> Result<i32> {
        if anchor.is_missing(at) {
            return Ok(MISSING_RANK);
        }
        let values = &self.order.values;
        let mut low = 0usize;
        let mut high = values.len();
        while low < high {
            let middle = low + (high - low) / 2;
            match compare_through_core(values, middle, anchor, at)? {
                Ordering::Equal => return rank_of(middle * 2 + 2),
                Ordering::Less => low = middle + 1,
                Ordering::Greater => high = middle,
            }
        }
        rank_of(low * 2 + 1)
    }
}

fn rank_of(rank: usize) -> Result<i32> {
    i32::try_from(rank).map_err(|_| {
        crate::error::NarsilError::new(
            crate::error::ErrorCode::CONFIG_INVALID,
            "The sort column holds more distinct values than the native rank layout",
        )
    })
}
