use std::collections::HashMap;
use std::ops::Range;
use std::sync::{Arc, Mutex};

use super::constants::MAX_CACHED_DERIVED_COLUMNS;
use super::segment::{SegmentData, SegmentEntry};
use crate::engine::SortMode;
use crate::error::Result;
use crate::ordering::KeyColumn;
use crate::schema::BaseType;

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
pub(crate) struct FacetColumn {
    names: Vec<String>,
    lookup: HashMap<String, u32>,
    offsets: Vec<u32>,
    ids: Vec<u32>,
}

impl FacetColumn {
    pub(crate) fn push_document<'k>(&mut self, keys: impl Iterator<Item = &'k str>) {
        if self.offsets.is_empty() {
            self.offsets.push(0);
        }
        for key in keys {
            let id = match self.lookup.get(key) {
                Some(id) => *id,
                None => {
                    let id = self.names.len() as u32;
                    self.names.push(key.to_string());
                    self.lookup.insert(key.to_string(), id);
                    id
                }
            };
            self.ids.push(id);
        }
        self.offsets.push(self.ids.len() as u32);
    }

    pub(crate) fn ids(&self, ordinal: u32) -> &[u32] {
        let at = ordinal as usize;
        let start = self.offsets.get(at).copied().unwrap_or(0) as usize;
        let end = self.offsets.get(at + 1).copied().unwrap_or(0) as usize;
        self.ids.get(start..end).unwrap_or(&[])
    }

    pub(crate) fn names(&self) -> &[String] {
        &self.names
    }
}

impl DerivedColumn for FacetColumn {
    fn len(&self) -> usize {
        self.offsets.len().saturating_sub(1)
    }
}

#[derive(Default)]
pub(crate) struct DerivedColumns {
    pub(crate) sort_keys: ColumnCache<(String, SortMode), KeyColumn>,
    pub(crate) facet_keys: ColumnCache<(String, Option<BaseType>), FacetColumn>,
}

impl SegmentEntry {
    pub(crate) fn derived(&self) -> &DerivedColumns {
        match &self.data {
            SegmentData::Frozen(segment) => &segment.stored_values.derived,
            SegmentData::Tail(tail) => &tail.derived,
        }
    }
}
