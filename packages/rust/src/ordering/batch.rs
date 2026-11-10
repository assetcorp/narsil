use std::cmp::Ordering;

use super::native::{build_order, every_ordinal};
use super::values::{OwnedSortValue, SortValues};
use crate::engine::SortDirection;
use crate::error::Result;

const MISSING_RANK: i32 = -1;

pub(crate) struct KeyBatch {
    columns: Vec<SortValues>,
}

pub(crate) struct RankedKeys {
    ranks: Vec<Vec<i32>>,
}

fn compare_rank(left: i32, right: i32, direction: SortDirection) -> Ordering {
    if left == right {
        return Ordering::Equal;
    }
    if left == MISSING_RANK {
        return Ordering::Greater;
    }
    if right == MISSING_RANK {
        return Ordering::Less;
    }
    match direction {
        SortDirection::Asc => left.cmp(&right),
        SortDirection::Desc => right.cmp(&left),
    }
}

impl KeyBatch {
    pub(crate) fn new(width: usize) -> KeyBatch {
        KeyBatch {
            columns: (0..width).map(|_| SortValues::default()).collect(),
        }
    }

    pub(crate) fn columns_mut(&mut self) -> &mut [SortValues] {
        &mut self.columns
    }

    pub(crate) fn push_key(&mut self, key: &[OwnedSortValue]) -> Result<()> {
        for (at, column) in self.columns.iter_mut().enumerate() {
            column.push(key.get(at).unwrap_or(&OwnedSortValue::Missing))?;
        }
        Ok(())
    }

    pub(crate) fn key(&self, row: usize) -> Vec<OwnedSortValue> {
        self.columns
            .iter()
            .map(|column| column.value(row))
            .collect()
    }

    pub(crate) fn ranked(&self) -> Result<RankedKeys> {
        let ranks = self
            .columns
            .iter()
            .map(|column| Ok(build_order(column, &every_ordinal(column.len()))?.ranks))
            .collect::<Result<Vec<Vec<i32>>>>()?;
        Ok(RankedKeys { ranks })
    }
}

impl RankedKeys {
    pub(crate) fn compare(
        &self,
        left: usize,
        right: usize,
        directions: &[SortDirection],
    ) -> Ordering {
        self.ranks
            .iter()
            .zip(directions)
            .map(|(ranks, direction)| compare_rank(ranks[left], ranks[right], *direction))
            .find(|order| *order != Ordering::Equal)
            .unwrap_or(Ordering::Equal)
    }
}
