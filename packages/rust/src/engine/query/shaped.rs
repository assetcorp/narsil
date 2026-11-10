use super::assemble::{assemble_groups, ranked_hit, sorted_hit};
use super::cursor::{decode_page_cursor, require_matching_cursor};
use super::gather::{QueryRun, text_ranked};
use super::highlight::highlight_hits;
use super::hybrid::hybrid_hits;
use super::projection::Projection;
use super::results::{FacetResult, GroupResult, Hit};
use super::scored::scored_query_page;
use super::sort_keys::SortPlan;
use super::sorted::{sorted_query_page, sorts_without_scores};
use super::vector::{SearchPlan, has_term, vector_hits};
use crate::error::Result;

pub(crate) struct ShapedPage {
    pub(crate) hits: Vec<Hit>,
    pub(crate) groups: Option<Vec<GroupResult>>,
    pub(crate) count: u64,
    pub(crate) count_exact: bool,
    pub(crate) cursor: Option<String>,
    pub(crate) facets: Option<Vec<(String, FacetResult)>>,
}

fn cursor_depth(run: &QueryRun<'_>) -> Result<usize> {
    let Some(cursor) = run.params.search_after.as_deref() else {
        return Ok(0);
    };
    let decoded = decode_page_cursor(cursor)?;
    require_matching_cursor(&decoded, run.signature.as_deref(), true, run.binding())?;
    Ok(usize::try_from(decoded.depth).unwrap_or(usize::MAX))
}

fn sorted_page(
    run: &QueryRun<'_>,
    plan: &SortPlan<'_>,
    signature: &str,
    projection: &Projection,
) -> Result<ShapedPage> {
    let page = sorted_query_page(run, plan, signature)?;
    let mut hits = Vec::with_capacity(page.hits.len());
    for (id, location) in page.hits {
        hits.extend(sorted_hit(run, id, location, projection)?);
    }
    highlight_hits(
        run.index,
        &run.snapshots.layout,
        &run.snapshots.partitions,
        run.params,
        &mut hits,
        projection,
    )?;
    Ok(ShapedPage {
        hits,
        groups: None,
        count: page.count,
        count_exact: true,
        cursor: page.cursor,
        facets: page.facets,
    })
}

pub(crate) fn shaped_page(
    run: &QueryRun<'_>,
    search: SearchPlan,
    projection: &Projection,
) -> Result<ShapedPage> {
    let params = run.params;
    let plan = params.sort.as_deref().map(SortPlan::of);
    let sorted_path =
        search == SearchPlan::Text && has_term(params) && sorts_without_scores(params);
    if let (Some(signature), Some(plan), true) = (run.signature.as_deref(), &plan, sorted_path) {
        return sorted_page(run, plan, signature, projection);
    }
    let input = match search {
        SearchPlan::Vector => vector_hits(run, cursor_depth(run)?)?,
        SearchPlan::Hybrid => hybrid_hits(run, cursor_depth(run)?)?,
        SearchPlan::Text => text_ranked(run, params)?,
    };
    let page = scored_query_page(run, plan.as_ref(), input)?;
    let mut hits = Vec::with_capacity(page.page.len());
    let mut pinned = Vec::with_capacity(page.page.len());
    for ranked in &page.page {
        if let Some(hit) = ranked_hit(run, ranked, projection)? {
            hits.push(hit);
            pinned.push(ranked.pinned);
        }
    }
    highlight_hits(
        run.index,
        &run.snapshots.layout,
        &run.snapshots.partitions,
        params,
        &mut hits,
        projection,
    )?;
    let groups = match page.groups {
        Some(groups) => Some(assemble_groups(run, groups, projection, &hits, &pinned)?),
        None => None,
    };
    Ok(ShapedPage {
        hits,
        groups,
        count: page.count,
        count_exact: page.count_exact,
        cursor: page.cursor,
        facets: page.facets,
    })
}
