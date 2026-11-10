use super::cursor::{PageCursor, decode_page_cursor, encode_page_cursor, require_matching_cursor};
use super::documents::Location;
use super::facets::count_facets;
use super::gather::{QueryRun, collected_segments, search_text};
use super::params::{QueryParams, TermMatch};
use super::results::FacetResult;
use super::sort_candidates::{SortAnchor, select_segment};
use super::sort_keys::SortPlan;
use crate::error::Result;
use crate::ordering::{KeyBatch, OwnedSortValue};
use crate::search::rankings::merge_sorted;

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

fn anchor_of(
    run: &QueryRun<'_>,
    plan: &SortPlan<'_>,
    signature: &str,
) -> Result<Option<SortAnchor>> {
    let Some(text) = run.params.search_after.as_deref() else {
        return Ok(None);
    };
    let decoded = decode_page_cursor(text)?;
    require_matching_cursor(&decoded, Some(signature), true, run.binding())?;
    let key = decoded
        .sort_key
        .unwrap_or_default()
        .iter()
        .map(OwnedSortValue::of_cursor)
        .collect();
    SortAnchor::of(decoded.anchor, key, plan.width()).map(Some)
}

fn cursor_after(run: &QueryRun<'_>, id: &str, key: &[OwnedSortValue], signature: &str) -> String {
    encode_page_cursor(&PageCursor {
        anchor: id.to_string(),
        score: None,
        sort_key: Some(
            key.iter()
                .cloned()
                .map(OwnedSortValue::cursor_value)
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
    let anchor = anchor_of(run, plan, signature)?;
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
    let wanted = run.offset.saturating_add(run.limit).saturating_add(1);
    let mut selected = Vec::new();
    let mut segment_bounds = vec![0usize];
    for segment in &segments {
        selected.extend(select_segment(segment, plan, anchor.as_ref(), wanted)?);
        segment_bounds.push(selected.len());
    }
    let mut batch = KeyBatch::new(plan.width());
    for candidate in &selected {
        batch.push_key(&candidate.key)?;
    }
    let ranked = batch.ranked()?;
    let mut by_key_then_id: Vec<usize> = (0..selected.len()).collect();
    by_key_then_id.sort_unstable_by(|&left, &right| {
        ranked
            .compare(left, right, &plan.directions)
            .then_with(|| selected[left].id.cmp(&selected[right].id))
    });
    let mut ranks = vec![0u32; selected.len()];
    for (rank, &at) in by_key_then_id.iter().enumerate() {
        ranks[at] = rank as u32;
    }
    let order = merge_sorted(&segment_bounds, &ranks, wanted)?;
    let has_more = order.len() > run.offset.saturating_add(run.limit);
    let page: Vec<usize> = order.into_iter().skip(run.offset).take(run.limit).collect();
    let cursor = match (has_more, page.last()) {
        (true, Some(&last)) => Some(cursor_after(
            run,
            &selected[last].id,
            &selected[last].key,
            signature,
        )),
        _ => None,
    };
    Ok(SortedPage {
        hits: page
            .iter()
            .map(|&at| (selected[at].id.clone(), selected[at].location))
            .collect(),
        count,
        cursor,
        facets,
    })
}
