use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::time::Duration;

use narsil::coordination::hits_kept_by_group;
use narsil::{
    Bm25Params, FacetResult, FacetSpec, Hit, Map, QueryCoverage, QueryParams, QueryResult,
    ScoringMode, SearchMode, SortDirection,
};

use crate::constants::{DEFAULT_FACET_SIZE, DEFAULT_PAGE_SIZE, MAX_FACET_SIZE, MAX_LIMIT};
use crate::query::wire_query::{WireFacet, WireGroup, WireQuery, WireVector};

pub(crate) fn bm25_sets_value(bm25: Option<&Bm25Params>) -> bool {
    let Some(bm25) = bm25 else {
        return false;
    };
    bm25.k1.is_some()
        || bm25.b.is_some()
        || bm25.fields.as_ref().is_some_and(|fields| {
            fields
                .iter()
                .any(|(_, pair)| pair.k1.is_some() || pair.b.is_some())
        })
}

pub(crate) fn facet_limit_of(spec: Option<&FacetSpec>) -> usize {
    let limit = spec.and_then(|spec| spec.limit);
    let ranges = spec.and_then(|spec| spec.ranges.as_ref());
    match (limit, ranges) {
        (None, Some(ranges)) => ranges.len().clamp(1, MAX_FACET_SIZE),
        (None, None) => DEFAULT_FACET_SIZE,
        (Some(limit), _) => limit.clamp(1, MAX_FACET_SIZE),
    }
}

fn wire_facet_size(facets: Option<&[(String, FacetSpec)]>) -> Option<usize> {
    let facets = facets?;
    let size = facets
        .iter()
        .map(|(_, spec)| facet_limit_of(Some(spec)))
        .max()
        .unwrap_or(0);
    (size != 0).then_some(size)
}

fn wire_facets(facets: &[(String, FacetSpec)]) -> Vec<WireFacet> {
    let mut wire: Vec<WireFacet> = Vec::with_capacity(facets.len());
    for (field, spec) in facets {
        let facet = WireFacet {
            field: field.clone(),
            sort: spec.sort,
            ranges: spec.ranges.clone(),
        };
        match wire.iter_mut().find(|held| held.field == *field) {
            Some(held) => *held = facet,
            None => wire.push(facet),
        }
    }
    wire
}

fn deduped_boost(boost: &[(String, f64)]) -> Vec<(String, f64)> {
    let mut deduped: Vec<(String, f64)> = Vec::with_capacity(boost.len());
    for (field, multiplier) in boost {
        match deduped.iter_mut().find(|(held, _)| held == field) {
            Some(held) => held.1 = *multiplier,
            None => deduped.push((field.clone(), *multiplier)),
        }
    }
    deduped
}

pub(crate) fn local_params_to_wire(params: &QueryParams) -> WireQuery {
    WireQuery {
        term: params.term.clone(),
        filters: params.filters.clone(),
        sort: params.sort.clone().filter(|sort| !sort.is_empty()),
        group: params.group.as_ref().map(|group| WireGroup {
            fields: group.fields.clone(),
            max_per_group: match group.reduce {
                Some(_) => MAX_LIMIT,
                None => hits_kept_by_group(group.max_per_group),
            },
            limit: group.limit,
        }),
        facets: params.facets.as_deref().map(wire_facets),
        facet_size: wire_facet_size(params.facets.as_deref()),
        limit: params.limit.unwrap_or(DEFAULT_PAGE_SIZE),
        offset: params.offset.unwrap_or(0),
        search_after: params.search_after.clone(),
        fields: params.fields.clone(),
        boost: params.boost.as_deref().map(deduped_boost),
        tolerance: params.tolerance,
        threshold: params.min_score,
        include_scores: params.include_scores,
        scoring: params.scoring.unwrap_or(ScoringMode::Local),
        term_match: params.term_match,
        prefix_length: params.prefix_length,
        prefix: params.prefix,
        partial_words: params.partial_words,
        exact: params.exact,
        pinned: params.pinned.clone(),
        mode: params.mode,
        vector: params.vector.as_ref().map(|query| WireVector {
            query: query.clone(),
            rescore_window: None,
        }),
        hybrid: params.hybrid,
        bm25: params
            .bm25
            .clone()
            .filter(|bm25| bm25_sets_value(Some(bm25))),
        index_bm25: None,
        analysis_generation: None,
    }
}

pub(crate) fn ascending_facet_fields(facets: Option<&[WireFacet]>) -> BTreeSet<String> {
    facets
        .unwrap_or_default()
        .iter()
        .filter(|facet| facet.sort == Some(SortDirection::Asc))
        .map(|facet| facet.field.clone())
        .collect()
}

pub(crate) fn count_is_exact_for(params: &QueryParams) -> bool {
    let Some(vector) = &params.vector else {
        return true;
    };
    if vector.value.is_none() && vector.text.is_none() {
        return true;
    }
    let has_term = params
        .term
        .as_deref()
        .is_some_and(|term| !term.trim().is_empty());
    if params.mode == Some(SearchMode::Hybrid) || has_term {
        return false;
    }
    vector.similarity.is_none()
}

pub(crate) fn distributed_count_is_exact(params: &QueryParams, coverage: &QueryCoverage) -> bool {
    if coverage.queried_partitions < coverage.total_partitions {
        return false;
    }
    if coverage.timed_out_partitions > 0 || coverage.failed_partitions > 0 {
        return false;
    }
    count_is_exact_for(params)
}

pub(crate) struct DistributedFacets {
    pub(crate) facets: Vec<(String, Vec<(String, u64)>)>,
    pub(crate) error_bounds: BTreeMap<String, u64>,
    pub(crate) undercounts: BTreeMap<String, u64>,
}

fn spec_of<'p>(requested: &'p [(String, FacetSpec)], field: &str) -> Option<&'p FacetSpec> {
    requested
        .iter()
        .rev()
        .find(|(held, _)| held == field)
        .map(|(_, spec)| spec)
}

fn local_facets(
    merged: &DistributedFacets,
    requested: Option<&[(String, FacetSpec)]>,
) -> Vec<(String, FacetResult)> {
    let mut converted = Vec::with_capacity(merged.facets.len());
    for (field, buckets) in &merged.facets {
        let merged_bound = merged.error_bounds.get(field).copied().unwrap_or(0);
        let kept = match requested {
            None => buckets.len(),
            Some(requested) => buckets.len().min(facet_limit_of(spec_of(requested, field))),
        };
        let largest_cut = buckets[kept..]
            .iter()
            .map(|(_, count)| *count)
            .max()
            .unwrap_or(0);
        let error_bound = match kept < buckets.len() {
            true => merged
                .undercounts
                .get(field)
                .copied()
                .unwrap_or(merged_bound)
                .saturating_add(largest_cut),
            false => merged_bound,
        };
        let mut values: Vec<(String, u64)> = Vec::with_capacity(kept);
        let mut places: HashMap<&str, usize> = HashMap::with_capacity(kept);
        for (value, count) in &buckets[..kept] {
            match places.get(value.as_str()) {
                Some(&place) => values[place].1 = *count,
                None => {
                    places.insert(value.as_str(), values.len());
                    values.push((value.clone(), *count));
                }
            }
        }
        converted.push((
            field.clone(),
            FacetResult {
                count: kept,
                values,
                error_bound: error_bound.max(merged_bound),
            },
        ));
    }
    converted
}

pub(crate) struct DistributedPage<'a> {
    pub(crate) scored: &'a [crate::query::search_answer::ScoredEntry],
    pub(crate) total_hits: u64,
    pub(crate) cursor: Option<String>,
    pub(crate) facets: Option<&'a DistributedFacets>,
    pub(crate) coverage: QueryCoverage,
}

pub(crate) fn distributed_result_to_local(
    page: DistributedPage<'_>,
    count_exact: bool,
    documents: &HashMap<String, Map>,
    requested_facets: Option<&[(String, FacetSpec)]>,
) -> QueryResult {
    QueryResult {
        hits: page
            .scored
            .iter()
            .map(|entry| Hit {
                id: entry.doc_id.clone(),
                score: entry.score,
                document: documents.get(&entry.doc_id).cloned().unwrap_or_default(),
                score_components: None,
                highlights: None,
            })
            .collect(),
        count: page.total_hits,
        count_exact,
        elapsed: Duration::ZERO,
        cursor: page.cursor,
        facets: page
            .facets
            .map(|facets| local_facets(facets, requested_facets)),
        groups: None,
        analysis_stale: false,
        coverage: page.coverage,
    }
}
