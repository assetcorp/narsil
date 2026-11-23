use std::collections::HashSet;
use std::ops::Range;

use crate::engine::query::constants::HYBRID_RESCORE_WINDOW;
use crate::engine::query::fusion::{
    Fusion, fixed_hybrid_depth, fuse, require_within_hybrid_depth, resolve_fusion,
};
use crate::engine::query::pagination::{PositionWindow, Positioned, page_by_position};
use crate::engine::{HybridConfig, HybridStrategy};
use crate::error::Result;
use crate::search::keyword::KeywordHit;

/// The re-score window that the vector leg of a fixed-depth hybrid query sets.
pub const HYBRID_VECTOR_RESCORE_WINDOW: usize = HYBRID_RESCORE_WINDOW;

/// The fusion settings of a hybrid query once checked, with each one that the query leaves out filled.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HybridFusion {
    /// How the rankings fuse.
    pub strategy: HybridStrategy,
    /// The rank constant of reciprocal rank fusion.
    pub k: f64,
    /// The weight of the vector ranking in linear fusion.
    pub alpha: f64,
}

/// Checks the fusion settings of `hybrid` and fills each one that it leaves out.
///
/// # Errors
///
/// Fails with `CONFIG_INVALID` for a rank constant or a weight out of range.
pub fn resolve_hybrid_fusion(hybrid: Option<&HybridConfig>) -> Result<HybridFusion> {
    let fusion = resolve_fusion(hybrid)?;
    Ok(HybridFusion {
        strategy: fusion.strategy,
        k: fusion.k,
        alpha: fusion.alpha,
    })
}

/// Returns the fixed depth of a hybrid query, or `None` where the query sets none.
///
/// # Errors
///
/// Fails with `CONFIG_INVALID` for a depth out of range.
pub fn hybrid_depth(hybrid: Option<&HybridConfig>) -> Result<Option<usize>> {
    fixed_hybrid_depth(hybrid)
}

/// Checks that a page of a fixed-depth hybrid query starts before its depth.
///
/// # Errors
///
/// Fails with `SEARCH_RESULT_WINDOW_EXCEEDED` where the page starts at the depth or past it.
pub fn require_hybrid_page_within(cursor_depth: usize, offset: usize, depth: usize) -> Result<()> {
    require_within_hybrid_depth(cursor_depth, offset, depth)
}

fn hits_of(entries: &[(String, Option<f64>)]) -> Vec<KeywordHit> {
    entries
        .iter()
        .map(|(id, score)| KeywordHit {
            id: id.clone(),
            score: score.unwrap_or(0.0),
            components: None,
        })
        .collect()
}

/// Fuses a text ranking and a vector ranking, each a list of document ids with their scores, as one engine fuses
/// them, best first.
///
/// # Errors
///
/// Fails with `CONFIG_INVALID` where the rankings exceed the native fusion layout.
pub fn fuse_hybrid_rankings(
    fusion: HybridFusion,
    text: &[(String, Option<f64>)],
    vector: &[(String, Option<f64>)],
) -> Result<Vec<(String, f64)>> {
    let fused = fuse(
        Fusion {
            strategy: fusion.strategy,
            k: fusion.k,
            alpha: fusion.alpha,
        },
        &hits_of(text),
        &hits_of(vector),
    )?;
    Ok(fused.into_iter().map(|hit| (hit.id, hit.score)).collect())
}

struct PlacedEntry<'a> {
    id: &'a str,
    score: Option<f64>,
}

impl Positioned for PlacedEntry<'_> {
    fn id(&self) -> &str {
        self.id
    }

    fn score(&self) -> Option<f64> {
        self.score
    }
}

/// The page of a fixed-depth hybrid query: the range of the placed list that it returns and the cursor of the next
/// page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PositionedPage {
    /// The range of the placed list on the page.
    pub range: Range<usize>,
    /// The cursor of the next page, or `None` on the last page.
    pub cursor: Option<String>,
}

/// Takes a page from `placed` by position, as one engine pages a fixed-depth hybrid query, where `organic` holds
/// the fused ranking before pin placement and `pinned_ids` the pins that placement used.
pub fn page_hybrid_by_position(
    placed: &[(String, Option<f64>)],
    organic: &[&str],
    start: usize,
    limit: usize,
    pinned_ids: Option<&HashSet<&str>>,
    binding: &str,
) -> PositionedPage {
    let entries: Vec<PlacedEntry<'_>> = placed
        .iter()
        .map(|(id, score)| PlacedEntry { id, score: *score })
        .collect();
    let page = page_by_position(
        &entries,
        organic,
        &PositionWindow {
            start,
            limit,
            pinned_ids,
            binding,
        },
    );
    PositionedPage {
        range: page.range,
        cursor: page.cursor,
    }
}
