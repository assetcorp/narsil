use std::borrow::Cow;
use std::collections::HashSet;
use std::sync::Arc;

use super::super::cursor::{PageCursor, encode_page_cursor};
use super::super::facets::MatchedSegment;
use super::super::params::SortField;
use super::super::sort_candidates::{SortAnchor, select_segment};
use super::super::sort_keys::SortPlan;
use super::seek::{PartitionPage, SegmentMatcher, matched_live_count};
use crate::error::Result;
use crate::index::partition::PartitionSnapshot;
use crate::ordering::{KeyBatch, OwnedSortValue};

pub(super) struct SortedRequest<'a> {
    pub(super) sort: &'a [SortField],
    pub(super) signature: &'a str,
    pub(super) binding: &'a str,
    pub(super) anchor: Option<(String, Vec<OwnedSortValue>)>,
    pub(super) limit: usize,
}

pub(super) struct ListingPage {
    pub(super) page: PartitionPage,
    pub(super) cursor: Option<String>,
}

fn cursor_after(request: &SortedRequest<'_>, id: &str, key: &[OwnedSortValue]) -> String {
    encode_page_cursor(&PageCursor {
        anchor: id.to_string(),
        score: None,
        sort_key: Some(
            key.iter()
                .cloned()
                .map(OwnedSortValue::cursor_value)
                .collect(),
        ),
        sort_signature: Some(request.signature.to_string()),
        depth: 0,
        binding: request.binding.to_string(),
    })
}

pub(super) fn sorted_listing(
    snapshots: &[Arc<PartitionSnapshot>],
    matcher: Option<&SegmentMatcher<'_>>,
    request: &SortedRequest<'_>,
) -> Result<ListingPage> {
    let plan = SortPlan::of(request.sort);
    let anchor = match &request.anchor {
        Some((id, key)) => Some(SortAnchor::of(id.clone(), key.clone(), plan.width())?),
        None => None,
    };
    let wanted = request.limit.saturating_add(1);
    let mut selected = Vec::new();
    let mut total = 0u64;
    for (partition_at, snapshot) in snapshots.iter().enumerate() {
        if matcher.is_none() {
            total += snapshot.document_count();
        }
        for (segment_at, entry) in snapshot.segments.iter().enumerate() {
            if entry.live_count() == 0 {
                continue;
            }
            let words = match matcher {
                Some(matcher) => {
                    let bits = matcher(entry)?;
                    total += matched_live_count(entry, &bits);
                    bits
                }
                None => entry.live_bits(),
            };
            let segment = MatchedSegment {
                partition: partition_at as u32,
                segment: segment_at as u32,
                entry,
                words: Cow::Owned(words),
            };
            selected.extend(select_segment(&segment, &plan, anchor.as_ref(), wanted)?);
        }
    }
    let mut batch = KeyBatch::new(plan.width());
    for candidate in &selected {
        batch.push_key(&candidate.key)?;
    }
    let ranked = batch.ranked()?;
    let mut order: Vec<usize> = (0..selected.len()).collect();
    order.sort_unstable_by(|&left, &right| {
        ranked
            .compare(left, right, &plan.directions)
            .then_with(|| selected[left].id.cmp(&selected[right].id))
    });
    let mut seen = HashSet::with_capacity(order.len());
    order.retain(|&at| seen.insert(selected[at].id.as_str()));
    let more_follow = order.len() > request.limit;
    order.truncate(request.limit);
    let cursor = match order.last() {
        Some(&last) if more_follow => Some(cursor_after(
            request,
            &selected[last].id,
            &selected[last].key,
        )),
        _ => None,
    };
    let ids = order.iter().map(|&at| selected[at].id.clone()).collect();
    Ok(ListingPage {
        page: PartitionPage { ids, total },
        cursor,
    })
}
