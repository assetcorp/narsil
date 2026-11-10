use std::cmp::Ordering;
use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::sync::Arc;

use super::documents::{Location, QuerySnapshots};
use super::params::{SortDirection, SortField, SortMode};
use crate::error::Result;
use crate::index::core_values::CoreStoredValues;
use crate::ordering::{KeyBatch, OwnedSortValue, default_sort_mode, push_reduced};

pub(crate) struct SortPlan<'p> {
    pub(crate) fields: Vec<&'p str>,
    pub(crate) directions: Vec<SortDirection>,
    pub(crate) modes: Vec<SortMode>,
}

impl<'p> SortPlan<'p> {
    pub(crate) fn of(sort: &'p [SortField]) -> SortPlan<'p> {
        SortPlan {
            fields: sort.iter().map(|entry| entry.field.as_str()).collect(),
            directions: sort.iter().map(|entry| entry.direction).collect(),
            modes: sort
                .iter()
                .map(|entry| entry.mode.unwrap_or(default_sort_mode(entry.direction)))
                .collect(),
        }
    }

    pub(crate) fn width(&self) -> usize {
        self.fields.len()
    }

    pub(crate) fn descending(&self) -> Vec<u8> {
        self.directions
            .iter()
            .map(|direction| u8::from(*direction == SortDirection::Desc))
            .collect()
    }

    pub(crate) fn compare(
        &self,
        left: &[OwnedSortValue],
        right: &[OwnedSortValue],
    ) -> Result<Ordering> {
        let mut batch = KeyBatch::new(self.width());
        batch.push_key(left)?;
        batch.push_key(right)?;
        Ok(batch.ranked()?.compare(0, 1, &self.directions))
    }
}

pub(crate) struct LocatedValues<'s> {
    snapshots: &'s QuerySnapshots,
    held: HashMap<(u32, u32), Vec<Arc<CoreStoredValues>>>,
}

impl<'s> LocatedValues<'s> {
    pub(crate) fn new(snapshots: &'s QuerySnapshots) -> LocatedValues<'s> {
        LocatedValues {
            snapshots,
            held: HashMap::new(),
        }
    }

    pub(crate) fn push_key(
        &mut self,
        plan: &SortPlan<'_>,
        location: Option<Location>,
        batch: &mut KeyBatch,
    ) -> Result<()> {
        let found = location.and_then(|location| Some((location, self.snapshots.entry(location)?)));
        let Some((location, entry)) = found else {
            return batch.push_key(&[]);
        };
        let slot = (location.partition, location.segment);
        let stored = match self.held.entry(slot) {
            Entry::Occupied(held) => held.into_mut(),
            Entry::Vacant(open) => open.insert(
                plan.fields
                    .iter()
                    .map(|path| entry.core_stored_values(path))
                    .collect::<Result<Vec<Arc<CoreStoredValues>>>>()?,
            ),
        };
        for ((values, mode), column) in stored.iter().zip(&plan.modes).zip(batch.columns_mut()) {
            push_reduced(values, location.ordinal, *mode, column)?;
        }
        Ok(())
    }
}

pub(crate) fn located_key(
    snapshots: &QuerySnapshots,
    plan: &SortPlan<'_>,
    location: Option<Location>,
) -> Result<Vec<OwnedSortValue>> {
    let mut batch = KeyBatch::new(plan.width());
    LocatedValues::new(snapshots).push_key(plan, location, &mut batch)?;
    Ok(batch.key(0))
}
