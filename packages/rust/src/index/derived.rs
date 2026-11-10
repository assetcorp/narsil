use std::ops::Range;
use std::sync::{Arc, Mutex};

use super::constants::MAX_CACHED_DERIVED_COLUMNS;
use super::core_values::CoreStoredValues;
use super::segment::{SegmentData, SegmentEntry};
use crate::engine::SortMode;
use crate::error::Result;
use crate::ordering::KeyColumn;

pub(crate) trait DerivedColumn: Clone + Default {
    fn len(&self) -> usize;
}

impl DerivedColumn for KeyColumn {
    fn len(&self) -> usize {
        KeyColumn::len(self)
    }
}

pub(crate) struct ColumnCache<K, C> {
    columns: Mutex<Vec<(K, Arc<C>)>>,
}

impl<K, C> Default for ColumnCache<K, C> {
    fn default() -> ColumnCache<K, C> {
        ColumnCache {
            columns: Mutex::new(Vec::new()),
        }
    }
}

impl<K, C: DerivedColumn> ColumnCache<K, C> {
    pub(crate) fn column(
        &self,
        matches: impl Fn(&K) -> bool,
        key: impl FnOnce() -> K,
        length: usize,
        grow: impl Fn(&mut C, Range<usize>) -> Result<()>,
    ) -> Result<Arc<C>> {
        let built = || -> Result<Arc<C>> {
            let mut column = C::default();
            grow(&mut column, 0..length)?;
            Ok(Arc::new(column))
        };
        let Ok(mut columns) = self.columns.lock() else {
            return built();
        };
        if let Some((_, column)) = columns.iter_mut().find(|(held, _)| matches(held)) {
            let held = column.len();
            if held > length {
                *column = built()?;
            } else if held < length {
                match Arc::get_mut(column) {
                    Some(owned) => grow(owned, held..length)?,
                    None => {
                        let mut copy = C::clone(column);
                        grow(&mut copy, held..length)?;
                        *column = Arc::new(copy);
                    }
                }
            }
            return Ok(column.clone());
        }
        let column = built()?;
        if columns.len() < MAX_CACHED_DERIVED_COLUMNS {
            columns.push((key(), column.clone()));
        }
        Ok(column)
    }
}

#[derive(Clone, Default)]
pub(crate) struct SortedNumbers {
    pub(crate) values: Vec<f64>,
    pub(crate) ordinals: Vec<u32>,
    covered: usize,
}

impl SortedNumbers {
    pub(crate) fn add(&mut self, entries: &[(u32, f64)], covered: usize) {
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
}

impl DerivedColumn for SortedNumbers {
    fn len(&self) -> usize {
        self.covered
    }
}

#[derive(Default)]
pub(crate) struct DerivedColumns {
    pub(crate) sort_keys: ColumnCache<(String, SortMode), KeyColumn>,
    pub(crate) sorted_numbers: ColumnCache<String, SortedNumbers>,
    pub(crate) stored_values: ColumnCache<String, CoreStoredValues>,
}

impl SegmentEntry {
    pub(crate) fn derived(&self) -> &DerivedColumns {
        match &self.data {
            SegmentData::Frozen(segment) => &segment.stored_values.derived,
            SegmentData::Tail(tail) => &tail.derived,
        }
    }
}
