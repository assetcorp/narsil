use std::sync::Arc;

use super::cursor::{PageCursor, decode_page_cursor, encode_page_cursor, require_matching_cursor};
use super::documents::Location;
use super::facets::count_facets;
use super::gather::{QueryRun, collected_segments, search_text};
use super::params::{QueryParams, TermMatch};
use super::results::FacetResult;
use super::sort_candidates::{Candidate, Gathered, SortAnchor, gather_segment, key_columns};
use super::sort_keys::SortPlan;
use crate::error::Result;
use crate::ordering::{KeyColumn, OwnedSortValue, SortValue};

pub(crate) struct SortedPage {
    pub(crate) hits: Vec<(String, Location)>,
    pub(crate) count: u64,
    pub(crate) cursor: Option<String>,
    pub(crate) facets: Option<Vec<(String, FacetResult)>>,
}

pub(crate) fn sorts_without_scores(params: &QueryParams) -> bool {
    params.include_scores != Some(true)
        && params.include_score_components != Some(true)
        && params.min_score.is_none()
        && params.group.is_none()
        && params.pinned.is_none()
        && params
            .term_match
            .is_none_or(|policy| policy == TermMatch::Any)
}

struct Anchor {
    id: String,
    key: Vec<OwnedSortValue>,
}

fn anchor_of(run: &QueryRun<'_>, signature: &str) -> Result<Option<Anchor>> {
    let Some(text) = run.params.search_after.as_deref() else {
        return Ok(None);
    };
    let decoded = decode_page_cursor(text)?;
    require_matching_cursor(&decoded, Some(signature), true, run.binding())?;
    Ok(Some(Anchor {
        id: decoded.anchor,
        key: decoded
            .sort_key
            .unwrap_or_default()
            .iter()
            .map(OwnedSortValue::of_cursor)
            .collect(),
    }))
}

fn cursor_after(
    run: &QueryRun<'_>,
    last: &Candidate<'_>,
    key: &[SortValue<'_>],
    signature: &str,
) -> String {
    encode_page_cursor(&PageCursor {
        anchor: last.id.to_string(),
        score: None,
        sort_key: Some(
            key.iter()
                .map(|value| value.owned().cursor_value())
                .collect(),
        ),
        sort_signature: Some(signature.to_string()),
        depth: 0,
        binding: run.binding().to_string(),
    })
}

pub(crate) fn sorted_query_page(
    run: &QueryRun<'_>,
    plan: &SortPlan<'_>,
    signature: &str,
) -> Result<SortedPage> {
    let anchor = anchor_of(run, signature)?;
    let width = plan.width();
    let sort_anchor = anchor.as_ref().map(|anchor| {
        let values: Vec<SortValue<'_>> = anchor.key.iter().map(OwnedSortValue::borrowed).collect();
        SortAnchor::of(anchor.id.as_str(), &values, width)
    });
    let outcome = search_text(run, run.params, true, true)?;
    let segments = collected_segments(&run.snapshots, &outcome.matched);
    let count: u64 = segments
        .iter()
        .map(|segment| {
            segment
                .words
                .iter()
                .map(|word| u64::from(word.count_ones()))
                .sum::<u64>()
        })
        .sum();
    let facets = match run.params.facets {
        Some(_) => Some(count_facets(run.index, run.params, &segments)?),
        None => None,
    };
    let columns = segments
        .iter()
        .map(|segment| key_columns(segment.entry, plan))
        .collect::<Result<Vec<Vec<Arc<KeyColumn>>>>>()?;
    let wanted = run.offset.saturating_add(run.limit).saturating_add(1);
    let mut gathered = Gathered {
        keys: Vec::new(),
        candidates: Vec::new(),
    };
    for (segment, columns) in segments.iter().zip(&columns) {
        gather_segment(
            &mut gathered,
            segment,
            columns,
            plan,
            sort_anchor.as_ref(),
            wanted,
        )?;
    }
    let Gathered {
        keys,
        mut candidates,
    } = gathered;
    let order = |left: &Candidate<'_>, right: &Candidate<'_>| {
        plan.compare(
            &keys[left.key_at..left.key_at + width],
            &keys[right.key_at..right.key_at + width],
        )
        .then_with(|| left.id.cmp(&right.id))
    };
    if candidates.len() > wanted {
        candidates.select_nth_unstable_by(wanted - 1, order);
        candidates.truncate(wanted);
    }
    candidates.sort_unstable_by(order);
    let has_more = candidates.len() > run.offset.saturating_add(run.limit);
    let page: Vec<&Candidate<'_>> = candidates.iter().skip(run.offset).take(run.limit).collect();
    let cursor = match (has_more, page.last()) {
        (true, Some(last)) => Some(cursor_after(
            run,
            last,
            &keys[last.key_at..last.key_at + width],
            signature,
        )),
        _ => None,
    };
    Ok(SortedPage {
        hits: page
            .iter()
            .map(|candidate| (candidate.id.to_string(), candidate.location))
            .collect(),
        count,
        cursor,
        facets,
    })
}
