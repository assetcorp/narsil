use std::cmp::Ordering;
use std::collections::HashSet;
use std::ops::Range;

use super::cursor::{PageCursor, decode_page_cursor, encode_page_cursor, require_matching_cursor};
use super::gather::QueryRun;
use super::page_start::{AnchorBits, page_start};
use super::params::Pin;
use super::pinned::{Placed, deduped_pins, place_pins};
use super::ranked::{Ranked, owned_key};
use super::results::Hit;
use super::sort_keys::SortPlan;
use crate::error::Result;
use crate::ordering::OwnedSortValue;

pub(crate) struct Placement {
    pub(crate) hits: Vec<Ranked>,
    pub(crate) placed_from_outside: u64,
}

pub(crate) fn place_pinned(
    run: &QueryRun<'_>,
    hits: Vec<Ranked>,
    pins: &[Pin],
) -> Result<Placement> {
    let mut stored = Vec::with_capacity(pins.len());
    let mut locations = Vec::with_capacity(pins.len());
    for pin in deduped_pins(pins) {
        if let Some(location) = run.locate(&pin.doc_id)? {
            stored.push(pin);
            locations.push(location);
        }
    }
    let (order, listed) = place_pins(hits.iter().map(|hit| hit.id.as_str()), hits.len(), &stored)?;
    let placed_from_outside = listed.iter().filter(|held| !**held).count() as u64;
    let mut ranked: Vec<Option<Ranked>> = hits.into_iter().map(Some).collect();
    let mut result = Vec::with_capacity(order.len());
    for entry in order {
        match entry {
            Placed::Ranked(place) => result.extend(ranked.get_mut(place).and_then(Option::take)),
            Placed::Pin(pin) => {
                if let (Some(pin), Some(&location)) = (stored.get(pin), locations.get(pin)) {
                    result.push(Ranked {
                        id: pin.doc_id.clone(),
                        score: 0.0,
                        components: None,
                        location: Some(location),
                        pinned: true,
                    });
                }
            }
        }
    }
    Ok(Placement {
        hits: result,
        placed_from_outside,
    })
}

pub(crate) struct Page {
    pub(crate) range: Range<usize>,
    pub(crate) cursor: Option<String>,
}

fn orders_after_anchor(
    run: &QueryRun<'_>,
    hit: &Ranked,
    anchor: &PageCursor,
    sort: Option<&SortPlan<'_>>,
) -> Result<bool> {
    let by_sort = match (sort, &anchor.sort_key) {
        (Some(plan), Some(anchor_key)) => {
            let key = owned_key(run, plan, hit.location)?;
            let theirs: Vec<OwnedSortValue> =
                anchor_key.iter().map(OwnedSortValue::of_cursor).collect();
            let own: Vec<_> = key.iter().map(OwnedSortValue::borrowed).collect();
            let theirs: Vec<_> = theirs.iter().map(OwnedSortValue::borrowed).collect();
            plan.compare(&own, &theirs)
        }
        _ => Ordering::Equal,
    };
    Ok(by_sort.then_with(|| hit.id.as_str().cmp(anchor.anchor.as_str())) == Ordering::Greater)
}

fn first_after_anchor(
    run: &QueryRun<'_>,
    hits: &[Ranked],
    anchor: &PageCursor,
    sort: Option<&SortPlan<'_>>,
) -> Result<usize> {
    let sorted = sort.is_some() && anchor.sort_key.is_some();
    let mut after = AnchorBits::new(hits.len());
    for (position, hit) in hits.iter().enumerate() {
        if orders_after_anchor(run, hit, anchor, sort)? {
            after.mark(position);
        }
    }
    let scores: Option<Vec<f64>> = (!sorted).then(|| hits.iter().map(|hit| hit.score).collect());
    page_start(hits.len(), scores.as_deref(), &after, anchor.score)
}

pub(crate) fn paginate(
    run: &QueryRun<'_>,
    hits: &[Ranked],
    sort: Option<&SortPlan<'_>>,
    pinned_ids: Option<&HashSet<&str>>,
) -> Result<Page> {
    let decoded = match run
        .params
        .search_after
        .as_deref()
        .filter(|cursor| !cursor.is_empty())
    {
        Some(cursor) => {
            let decoded = decode_page_cursor(cursor)?;
            require_matching_cursor(&decoded, run.signature.as_deref(), true, run.binding())?;
            Some(decoded)
        }
        None => None,
    };
    if run.limit == 0 {
        return Ok(Page {
            range: 0..0,
            cursor: None,
        });
    }
    let start = match &decoded {
        Some(anchor) => first_after_anchor(run, hits, anchor, sort)?,
        None => 0,
    };
    let after_offset = start.saturating_add(run.offset);
    let begin = after_offset.min(hits.len());
    let end = after_offset.saturating_add(run.limit).min(hits.len());
    let has_more = after_offset.saturating_add(run.limit) < hits.len();
    let last = hits[begin..end]
        .iter()
        .rev()
        .find(|hit| pinned_ids.is_none_or(|ids| !ids.contains(hit.id.as_str())));
    let depth = (after_offset + (end - begin)) as u64;
    let cursor = match (has_more, last) {
        (true, Some(last)) => {
            let sort_key = match sort {
                Some(plan) => Some(
                    owned_key(run, plan, last.location)?
                        .into_iter()
                        .map(OwnedSortValue::cursor_value)
                        .collect(),
                ),
                None => None,
            };
            Some(encode_page_cursor(&PageCursor {
                anchor: last.id.clone(),
                score: sort.is_none().then_some(last.score),
                sort_key,
                sort_signature: sort.and(run.signature.clone()),
                depth,
                binding: run.binding().to_string(),
            }))
        }
        _ => None,
    };
    Ok(Page {
        range: begin..end,
        cursor,
    })
}

pub(crate) trait Positioned {
    fn id(&self) -> &str;
    fn score(&self) -> Option<f64>;
}

impl Positioned for Ranked {
    fn id(&self) -> &str {
        &self.id
    }

    fn score(&self) -> Option<f64> {
        Some(self.score)
    }
}

impl Positioned for Hit {
    fn id(&self) -> &str {
        &self.id
    }

    fn score(&self) -> Option<f64> {
        self.score
    }
}

pub(crate) struct PositionWindow<'a> {
    pub(crate) start: usize,
    pub(crate) limit: usize,
    pub(crate) pinned_ids: Option<&'a HashSet<&'a str>>,
    pub(crate) binding: &'a str,
}

pub(crate) fn page_by_position<P: Positioned>(
    placed: &[P],
    organic: &[&str],
    window: &PositionWindow<'_>,
) -> Page {
    if window.limit == 0 {
        return Page {
            range: 0..0,
            cursor: None,
        };
    }
    let begin = window.start.min(placed.len());
    let end = window.start.saturating_add(window.limit).min(placed.len());
    let page = &placed[begin..end];
    let last = page
        .iter()
        .enumerate()
        .rev()
        .find(|(_, hit)| window.pinned_ids.is_none_or(|ids| !ids.contains(hit.id())));
    let reaches_end = placed.len() <= window.start.saturating_add(window.limit);
    let cursor = match (reaches_end, last) {
        (false, Some((at, last))) => {
            let depth = match window.pinned_ids {
                None => window.start + at + 1,
                Some(_) => organic
                    .iter()
                    .position(|id| *id == last.id())
                    .map_or(0, |position| position + 1),
            };
            Some(encode_page_cursor(&PageCursor {
                anchor: last.id().to_string(),
                score: last.score(),
                sort_key: None,
                sort_signature: None,
                depth: depth as u64,
                binding: window.binding.to_string(),
            }))
        }
        _ => None,
    };
    Page {
        range: begin..end,
        cursor,
    }
}
