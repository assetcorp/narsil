use std::cmp::Ordering;
use std::collections::HashSet;
use std::ops::Range;

use super::cursor::{PageCursor, decode_page_cursor, encode_page_cursor, require_matching_cursor};
use super::gather::QueryRun;
use super::params::Pin;
use super::ranked::{Ranked, owned_key};
use super::results::Hit;
use super::sort_keys::SortPlan;
use crate::error::Result;
use crate::ordering::OwnedSortValue;

pub(crate) struct Placement {
    pub(crate) hits: Vec<Ranked>,
    pub(crate) placed_from_outside: u64,
}

pub(crate) fn deduped_pins(pins: &[Pin]) -> Vec<&Pin> {
    let mut deduped: Vec<&Pin> = Vec::with_capacity(pins.len());
    for pin in pins {
        if !deduped.iter().any(|held| held.doc_id == pin.doc_id) {
            deduped.push(pin);
        }
    }
    deduped
}

pub(crate) fn place_pinned(
    run: &QueryRun<'_>,
    hits: Vec<Ranked>,
    pins: &[Pin],
) -> Result<Placement> {
    let mut deduped = deduped_pins(pins);
    let pinned_ids: HashSet<&str> = deduped.iter().map(|pin| pin.doc_id.as_str()).collect();
    let mut listed: HashSet<String> = HashSet::new();
    let mut result: Vec<Ranked> = Vec::with_capacity(hits.len() + deduped.len());
    for hit in hits {
        if pinned_ids.contains(hit.id.as_str()) {
            listed.insert(hit.id);
            continue;
        }
        result.push(hit);
    }
    deduped.sort_by_key(|pin| pin.position);
    let mut placed_from_outside = 0;
    for pin in deduped {
        let Some(location) = run.locate(&pin.doc_id)? else {
            continue;
        };
        if !listed.contains(&pin.doc_id) {
            placed_from_outside += 1;
        }
        let at = pin.position.min(result.len());
        result.insert(
            at,
            Ranked {
                id: pin.doc_id.clone(),
                score: 0.0,
                components: None,
                location: Some(location),
                pinned: true,
            },
        );
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
    if let (Some(plan), Some(anchor_key)) = (sort, &anchor.sort_key) {
        let key = owned_key(run, plan, hit.location)?;
        let theirs: Vec<OwnedSortValue> =
            anchor_key.iter().map(OwnedSortValue::of_cursor).collect();
        let own: Vec<_> = key.iter().map(OwnedSortValue::borrowed).collect();
        let theirs: Vec<_> = theirs.iter().map(OwnedSortValue::borrowed).collect();
        return Ok(plan
            .compare(&own, &theirs)
            .then_with(|| hit.id.as_str().cmp(anchor.anchor.as_str()))
            == Ordering::Greater);
    }
    let Some(score) = anchor.score else {
        return Ok(true);
    };
    Ok(hit.score < score || (hit.score == score && hit.id.as_str() > anchor.anchor.as_str()))
}

fn first_after_anchor(
    run: &QueryRun<'_>,
    hits: &[Ranked],
    anchor: &PageCursor,
    sort: Option<&SortPlan<'_>>,
) -> Result<usize> {
    for (at, hit) in hits.iter().enumerate() {
        if orders_after_anchor(run, hit, anchor, sort)? {
            return Ok(at);
        }
    }
    Ok(hits.len())
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
