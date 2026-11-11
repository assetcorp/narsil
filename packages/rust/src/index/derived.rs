use std::ops::Range;
use std::sync::Arc;

use super::constants::MAX_CACHED_DERIVED_COLUMNS;
use super::core_values::CoreStoredValues;
use super::published::Published;
use super::segment::{SegmentData, SegmentEntry};
use crate::engine::SortMode;
use crate::error::Result;
use crate::ordering::SortColumn;

pub(crate) trait DerivedColumn: Clone + Default {
    fn len(&self) -> usize;
}

impl DerivedColumn for SortColumn {
    fn len(&self) -> usize {
        SortColumn::len(self)
    }
}

pub(crate) struct ColumnCache<K, C> {
    columns: Published<(K, Arc<C>)>,
    kept: Option<Arc<Published<K>>>,
}

impl<K, C> Default for ColumnCache<K, C> {
    fn default() -> ColumnCache<K, C> {
        ColumnCache {
            columns: Published::default(),
            kept: None,
        }
    }
}

impl<K: Clone, C> Clone for ColumnCache<K, C> {
    fn clone(&self) -> ColumnCache<K, C> {
        ColumnCache {
            columns: self.columns.clone(),
            kept: self.kept.clone(),
        }
    }
}

impl<K: PartialEq + Clone, C: DerivedColumn> ColumnCache<K, C> {
    fn kept_by(kept: &Arc<Published<K>>) -> ColumnCache<K, C> {
        ColumnCache {
            columns: Published::default(),
            kept: Some(Arc::clone(kept)),
        }
    }

    pub(crate) fn column(
        &self,
        matches: impl Fn(&K) -> bool,
        key: impl FnOnce() -> K,
        length: usize,
        grow: impl Fn(&mut C, Range<usize>) -> Result<()>,
    ) -> Result<Arc<C>> {
        if let Some((_, held)) = self.columns.find(|(held, _)| matches(held)) {
            if held.len() == length {
                return Ok(Arc::clone(held));
            }
            if held.len() < length {
                let mut copy = C::clone(held);
                grow(&mut copy, held.len()..length)?;
                return Ok(Arc::new(copy));
            }
        }
        let mut column = C::default();
        grow(&mut column, 0..length)?;
        let column = Arc::new(column);
        match &self.kept {
            Some(kept) => {
                let _ = kept.publish(key(), &matches, MAX_CACHED_DERIVED_COLUMNS);
                Ok(column)
            }
            None => match self.columns.publish(
                (key(), Arc::clone(&column)),
                |(held, _)| matches(held),
                MAX_CACHED_DERIVED_COLUMNS,
            ) {
                Ok((_, winner)) => Ok(Arc::clone(winner)),
                Err(_) => Ok(column),
            },
        }
    }

    pub(crate) fn keep(
        &mut self,
        length: usize,
        grow: impl Fn(&K, &mut C, Range<usize>) -> Result<()>,
    ) -> Result<()> {
        if let Some(kept) = &self.kept {
            let missing: Vec<K> = kept
                .iter()
                .filter(|key| self.columns.find(|(held, _)| held == *key).is_none())
                .cloned()
                .collect();
            for key in missing {
                self.columns.push_held((key, Arc::new(C::default())));
            }
        }
        self.columns.try_for_each_held(|(key, column)| {
            let held = column.len();
            match held < length {
                true => grow(key, Arc::make_mut(column), held..length),
                false => Ok(()),
            }
        })
    }
}

#[derive(Clone, Default)]
pub(crate) struct SortedNumbers {
    pub(crate) values: Vec<f64>,
    pub(crate) ordinals: Vec<u32>,
    covered: usize,
}

impl SortedNumbers {
    fn add(&mut self, entries: &[(u32, f64)], covered: usize) {
        let mut added: Vec<(u32, f64)> = entries.to_vec();
        added.sort_by(|left, right| left.1.total_cmp(&right.1));
        let mut values = Vec::with_capacity(self.values.len() + added.len());
        let mut ordinals = Vec::with_capacity(values.capacity());
        let mut held = self.values.iter().zip(&self.ordinals).peekable();
        for (ordinal, value) in added {
            while let Some((held_value, held_ordinal)) =
                held.next_if(|(held_value, _)| held_value.total_cmp(&value).is_le())
            {
                values.push(*held_value);
                ordinals.push(*held_ordinal);
            }
            values.push(value);
            ordinals.push(ordinal);
        }
        for (held_value, held_ordinal) in held {
            values.push(*held_value);
            ordinals.push(*held_ordinal);
        }
        self.values = values;
        self.ordinals = ordinals;
        self.covered = covered;
    }

    pub(crate) fn add_range(&mut self, entries: &[(u32, f64)], range: Range<usize>) {
        let start = entries.partition_point(|(ordinal, _)| (*ordinal as usize) < range.start);
        let end = entries.partition_point(|(ordinal, _)| (*ordinal as usize) < range.end);
        self.add(&entries[start..end], range.end);
    }
}

impl DerivedColumn for SortedNumbers {
    fn len(&self) -> usize {
        self.covered
    }
}

#[derive(Clone, Default)]
pub(crate) struct KeptColumns {
    sort_columns: Arc<Published<(String, SortMode)>>,
    sorted_numbers: Arc<Published<String>>,
    stored_values: Arc<Published<String>>,
}

#[derive(Default, Clone)]
pub(crate) struct DerivedColumns {
    pub(crate) sort_columns: ColumnCache<(String, SortMode), SortColumn>,
    pub(crate) sorted_numbers: ColumnCache<String, SortedNumbers>,
    pub(crate) stored_values: ColumnCache<String, CoreStoredValues>,
}

impl DerivedColumns {
    pub(crate) fn kept_by(kept: &KeptColumns) -> DerivedColumns {
        DerivedColumns {
            sort_columns: ColumnCache::kept_by(&kept.sort_columns),
            sorted_numbers: ColumnCache::kept_by(&kept.sorted_numbers),
            stored_values: ColumnCache::kept_by(&kept.stored_values),
        }
    }
}

impl SegmentEntry {
    pub(crate) fn derived(&self) -> &DerivedColumns {
        match &self.data {
            SegmentData::Frozen(segment) => &segment.stored_values.derived,
            SegmentData::Tail(tail) => &tail.derived,
        }
    }
}
