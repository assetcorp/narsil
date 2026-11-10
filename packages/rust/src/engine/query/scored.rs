use std::collections::HashSet;

use super::gather::QueryRun;
use super::grouping::{GroupDraft, group_hits};
use super::pagination::{Page, PositionWindow, page_by_position, paginate, place_pinned};
use super::params::{QueryParams, TermMatch};
use super::ranked::{Ranked, sort_ranked};
use super::results::FacetResult;
use super::sort_keys::SortPlan;
use super::vector::RankedHits;
use crate::error::Result;

pub(crate) struct ScoredPage {
    pub(crate) page: Vec<Ranked>,
    pub(crate) groups: Option<Vec<GroupDraft>>,
    pub(crate) count: u64,
    pub(crate) count_exact: bool,
    pub(crate) cursor: Option<String>,
    pub(crate) facets: Option<Vec<(String, FacetResult)>>,
}

fn needs_full_hits(params: &QueryParams) -> bool {
    params.sort.is_some()
        || params.group.is_some()
        || params.pinned.is_some()
        || params.search_after.is_some()
}

pub(crate) fn needs_all_results(params: &QueryParams) -> bool {
    params.min_score.is_some()
        || params
            .term_match
            .is_some_and(|policy| policy != TermMatch::Any)
        || needs_full_hits(params)
}

fn page_of(
    run: &QueryRun<'_>,
    hits: &[Ranked],
    organic: &[String],
    position_depth: Option<usize>,
    sort: Option<&SortPlan<'_>>,
    pinned_ids: Option<&HashSet<&str>>,
) -> Result<Page> {
    let Some(cursor_depth) = position_depth else {
        return paginate(run, hits, sort, pinned_ids);
    };
    let organic: Vec<&str> = organic.iter().map(String::as_str).collect();
    Ok(page_by_position(
        hits,
        &organic,
        &PositionWindow {
            start: cursor_depth.saturating_add(run.offset),
            limit: run.limit,
            pinned_ids,
            binding: run.binding(),
        },
    ))
}

pub(crate) fn scored_query_page(
    run: &QueryRun<'_>,
    plan: Option<&SortPlan<'_>>,
    input: RankedHits,
) -> Result<ScoredPage> {
    let params = run.params;
    let holds_every_match = input.exact && input.hits.len() as u64 == input.total_matched;
    let mut locations = input.locations.into_iter();
    let mut hits: Vec<Ranked> = input
        .hits
        .into_iter()
        .map(|hit| Ranked::from_keyword(hit, locations.next().flatten()))
        .collect();
    if !needs_full_hits(params) {
        hits.truncate(run.offset.saturating_add(run.limit).saturating_add(1));
    }
    let sorting = plan.filter(|plan| plan.width() > 0);
    if let Some(plan) = sorting {
        hits = sort_ranked(run, plan, hits)?;
    }
    let groups = match &params.group {
        Some(config) => Some(group_hits(run, config, &mut hits)?),
        None => None,
    };
    let mut placed_from_outside = 0;
    let mut pinned_ids: Option<HashSet<&str>> = None;
    let mut organic: Vec<String> = Vec::new();
    if let (Some(pins), None) = (&params.pinned, &params.search_after) {
        if input.position_depth.is_some() {
            organic = hits.iter().map(|hit| hit.id.clone()).collect();
        }
        let placement = place_pinned(run, hits, pins)?;
        hits = placement.hits;
        placed_from_outside = placement.placed_from_outside;
        pinned_ids = Some(pins.iter().map(|pin| pin.doc_id.as_str()).collect());
    }
    let page = page_of(
        run,
        &hits,
        &organic,
        input.position_depth,
        run.signature.as_ref().and(sorting),
        pinned_ids.as_ref(),
    )?;
    let page_hits: Vec<Ranked> = hits.drain(page.range).collect();
    Ok(ScoredPage {
        page: page_hits,
        groups,
        count: input.total_matched
            + if holds_every_match {
                placed_from_outside
            } else {
                0
            },
        count_exact: input.exact && (holds_every_match || placed_from_outside == 0),
        cursor: page.cursor,
        facets: input.facets,
    })
}
