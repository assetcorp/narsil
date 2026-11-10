use std::sync::Arc;

use super::documents::{Location, matched_ordinals};
use super::facets::MatchedSegment;
use super::sort_keys::SortPlan;
use crate::error::Result;
use crate::ffi;
use crate::ordering::{
    KeyBatch, OwnedSortValue, SelectRequest, SortColumn, SortValues, padded, sort_select,
};

pub(crate) struct SortAnchor {
    pub(crate) id: String,
    pub(crate) key: Vec<OwnedSortValue>,
    values: SortValues,
}

impl SortAnchor {
    pub(crate) fn of(id: String, key: Vec<OwnedSortValue>, width: usize) -> Result<SortAnchor> {
        let mut values = SortValues::default();
        for at in 0..width {
            values.push(key.get(at).unwrap_or(&OwnedSortValue::Missing))?;
        }
        Ok(SortAnchor {
            id,
            key: (0..width).map(|at| values.value(at)).collect(),
            values,
        })
    }
}

pub(crate) struct Selected {
    pub(crate) id: String,
    pub(crate) location: Location,
    pub(crate) key: Vec<OwnedSortValue>,
}

struct SegmentColumns<'s> {
    segment: &'s MatchedSegment<'s>,
    columns: Vec<Arc<SortColumn>>,
}

impl SegmentColumns<'_> {
    fn selected(&self, ordinal: u32) -> Result<Selected> {
        Ok(Selected {
            id: self.segment.entry.id_of(ordinal)?.into_owned(),
            location: Location {
                partition: self.segment.partition,
                segment: self.segment.segment,
                ordinal,
            },
            key: self
                .columns
                .iter()
                .map(|column| column.value(ordinal))
                .collect(),
        })
    }
}

fn after_anchor(
    page: Vec<Selected>,
    plan: &SortPlan<'_>,
    anchor: &SortAnchor,
) -> Result<Vec<Selected>> {
    let mut batch = KeyBatch::new(plan.width());
    batch.push_key(&anchor.key)?;
    for selected in &page {
        batch.push_key(&selected.key)?;
    }
    let ranked = batch.ranked()?;
    Ok(page
        .into_iter()
        .enumerate()
        .filter(
            |(at, selected)| match ranked.compare(at + 1, 0, &plan.directions) {
                std::cmp::Ordering::Greater => true,
                std::cmp::Ordering::Equal => selected.id > anchor.id,
                std::cmp::Ordering::Less => false,
            },
        )
        .map(|(_, selected)| selected)
        .collect())
}

fn unsorted(held: &SegmentColumns<'_>, anchor: Option<&SortAnchor>) -> Result<Vec<Selected>> {
    let mut page = Vec::new();
    for ordinal in matched_ordinals(&held.segment.words) {
        let selected = held.selected(ordinal)?;
        if anchor.is_none_or(|anchor| selected.id > anchor.id) {
            page.push(selected);
        }
    }
    Ok(page)
}

pub(crate) fn select_segment(
    segment: &MatchedSegment<'_>,
    plan: &SortPlan<'_>,
    anchor: Option<&SortAnchor>,
    wanted: usize,
) -> Result<Vec<Selected>> {
    let entry = segment.entry;
    let held = SegmentColumns {
        segment,
        columns: plan
            .fields
            .iter()
            .zip(&plan.modes)
            .map(|(path, mode)| entry.sort_column(path, *mode))
            .collect::<Result<Vec<Arc<SortColumn>>>>()?,
    };
    if held.columns.is_empty() {
        return unsorted(&held, anchor);
    }
    let capacity = entry.capacity() as usize;
    if capacity == 0 || wanted == 0 {
        return Ok(Vec::new());
    }
    let views: Vec<ffi::narsil_sort_column> =
        held.columns.iter().map(|column| column.view()).collect();
    let filter = padded(&segment.words, capacity);
    let live = entry.live_bits();
    let descending = plan.descending();
    let anchor_ranks = match anchor {
        Some(anchor) => Some(
            held.columns
                .iter()
                .enumerate()
                .map(|(at, column)| column.anchor_rank(&anchor.values, at))
                .collect::<Result<Vec<i32>>>()?,
        ),
        None => None,
    };
    let mut requested = wanted.min(capacity);
    loop {
        let ordinals = sort_select(&SelectRequest {
            columns: &views,
            descending: &descending,
            filter: &filter,
            live: &live,
            limit: u32::try_from(requested).unwrap_or(u32::MAX),
            anchor: anchor_ranks
                .as_deref()
                .zip(anchor.map(|anchor| &anchor.values)),
        })?;
        let mut page = ordinals
            .iter()
            .map(|ordinal| held.selected(*ordinal))
            .collect::<Result<Vec<Selected>>>()?;
        if let Some(anchor) = anchor {
            page = after_anchor(page, plan, anchor)?;
        }
        if page.len() >= wanted || ordinals.len() < requested || requested >= capacity {
            return Ok(page);
        }
        requested = capacity.min((requested * 2).max(requested + wanted - page.len()));
    }
}
