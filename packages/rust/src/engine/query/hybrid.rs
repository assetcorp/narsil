use std::collections::HashSet;

use super::constants::HYBRID_RESCORE_WINDOW;
use super::fusion::{
    Fusion, fixed_hybrid_depth, linear_combination, reciprocal_rank_fusion,
    require_within_hybrid_depth, resolve_fusion,
};
use super::gather::{QueryRun, text_ranked};
use super::params::{HybridStrategy, QueryParams};
use super::vector::{
    RankedHits, VectorLeg, filter_snapshots, id_slices, require_usable_vector_options,
    vector_fetch_depth, vector_leg,
};
use crate::error::Result;
use crate::search::keyword::KeywordHit;

fn fused(fusion: Fusion, text: &[KeywordHit], vector: &[KeywordHit]) -> Vec<KeywordHit> {
    match fusion.strategy {
        HybridStrategy::Rrf => reciprocal_rank_fusion([text, vector], fusion.k),
        HybridStrategy::Linear => linear_combination(text, vector, fusion.alpha),
    }
}

fn text_only(text: RankedHits) -> RankedHits {
    RankedHits {
        hits: text.hits,
        total_matched: text.total_matched,
        facets: text.facets,
        ..RankedHits::empty()
    }
}

fn score_floor(params: &QueryParams) -> Option<f64> {
    params.min_score.filter(|threshold| *threshold > 0.0)
}

/// Runs a hybrid query: its full-text search and its vector search, fused into one ranking, past the
/// `cursor_depth` results that earlier pages returned.
pub(crate) fn hybrid_hits(run: &QueryRun<'_>, cursor_depth: usize) -> Result<RankedHits> {
    require_usable_vector_options(run.params.vector.as_ref())?;
    match fixed_hybrid_depth(run.params.hybrid.as_ref())? {
        Some(depth) => fixed_depth_hits(run, depth, cursor_depth),
        None => paged_hits(run, cursor_depth),
    }
}

fn paged_hits(run: &QueryRun<'_>, cursor_depth: usize) -> Result<RankedHits> {
    let (index, params, scope) = (run.index, run.params, run.scope);
    let fusion = resolve_fusion(params.hybrid.as_ref())?;
    let snapshots = filter_snapshots(index, scope);
    let matched = scope.matched_ids(&snapshots)?;
    if matched.as_ref().is_some_and(Vec::is_empty) {
        return Ok(RankedHits::empty());
    }
    let Some((clause, query)) = params
        .vector
        .as_ref()
        .and_then(|clause| clause.value.as_ref().map(|query| (clause, query)))
    else {
        return Ok(text_only(text_ranked(run, params)?));
    };
    let k = vector_fetch_depth(run.limit, run.offset, cursor_depth)?;
    let text = text_ranked(run, params)?;
    let matching = id_slices(&matched);
    let vector = vector_leg(index, clause, query, k, None, matching.as_deref())?;
    let mut hits = fused(fusion, &text.hits, &vector.hits);
    if let Some(threshold) = score_floor(params) {
        hits.retain(|hit| hit.score >= threshold);
    }
    let text_holds_every_match = text.hits.len() as u64 == text.total_matched;
    Ok(RankedHits {
        total_matched: hits.len() as u64,
        hits,
        exact: vector.holds_every_match && text_holds_every_match,
        facets: text.facets,
        ..RankedHits::empty()
    })
}

fn count_of_union(text: &RankedHits, vector: &VectorLeg) -> u64 {
    let text_ids: HashSet<&str> = text.hits.iter().map(|hit| hit.id.as_str()).collect();
    let vector_only = vector
        .hits
        .iter()
        .filter(|hit| !text_ids.contains(hit.id.as_str()))
        .count() as u64;
    let held = text.hits.len() as u64;
    if held == text.total_matched {
        return text.total_matched + vector_only;
    }
    text.total_matched.max(held + vector_only)
}

fn fixed_depth_hits(run: &QueryRun<'_>, depth: usize, cursor_depth: usize) -> Result<RankedHits> {
    let (index, params, scope) = (run.index, run.params, run.scope);
    require_within_hybrid_depth(cursor_depth, run.offset, depth)?;
    let fusion = resolve_fusion(params.hybrid.as_ref())?;
    let position_depth = Some(cursor_depth);
    let snapshots = filter_snapshots(index, scope);
    let matched = scope.matched_ids(&snapshots)?;
    if matched.as_ref().is_some_and(Vec::is_empty) {
        return Ok(RankedHits {
            position_depth,
            ..RankedHits::empty()
        });
    }
    let mut text_params = params.clone();
    text_params.limit = Some(depth);
    text_params.offset = Some(0);
    text_params.search_after = None;
    text_params.pinned = None;
    let Some((clause, query)) = params
        .vector
        .as_ref()
        .and_then(|clause| clause.value.as_ref().map(|query| (clause, query)))
    else {
        return Ok(RankedHits {
            position_depth,
            ..text_only(text_ranked(run, &text_params)?)
        });
    };
    let text = text_ranked(run, &text_params)?;
    let matching = id_slices(&matched);
    let vector = vector_leg(
        index,
        clause,
        query,
        depth,
        Some(HYBRID_RESCORE_WINDOW),
        matching.as_deref(),
    )?;
    let text_ranked_hits = &text.hits[..text.hits.len().min(depth)];
    let mut hits = fused(fusion, text_ranked_hits, &vector.hits);
    let threshold = score_floor(params);
    if let Some(threshold) = threshold {
        hits.retain(|hit| hit.score >= threshold);
    }
    let filters_by_score = threshold.is_some();
    let fused_count = hits.len() as u64;
    hits.truncate(depth);
    let text_holds_every_match = text.hits.len() as u64 == text.total_matched;
    let exact = vector.holds_every_match
        && text_holds_every_match
        && (!filters_by_score || text_ranked_hits.len() as u64 == text.total_matched);
    Ok(RankedHits {
        hits,
        total_matched: if filters_by_score {
            fused_count
        } else {
            count_of_union(&text, &vector)
        },
        exact,
        facets: text.facets,
        locations: Vec::new(),
        position_depth,
    })
}
