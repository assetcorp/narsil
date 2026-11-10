use std::cmp::Ordering;
use std::collections::HashMap;

use super::constants::{
    DEFAULT_LINEAR_ALPHA, DEFAULT_RANK_CONSTANT, MAX_HYBRID_DEPTH, MAX_LINEAR_ALPHA,
    MIN_HYBRID_DEPTH, MIN_LINEAR_ALPHA, MIN_RANK_CONSTANT,
};
use super::params::{HybridConfig, HybridStrategy};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::search::components::ScoreComponents;
use crate::search::keyword::KeywordHit;
use crate::search::rankings::score_then_id;

/// The fusion settings of a hybrid query once the engine has checked them.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Fusion {
    pub(crate) strategy: HybridStrategy,
    pub(crate) k: f64,
    pub(crate) alpha: f64,
}

fn config_invalid(message: String) -> NarsilError {
    NarsilError::new(ErrorCode::CONFIG_INVALID, message)
}

/// Checks a hybrid query's strategy, rank constant, and weight, filling each one that it leaves out.
pub(crate) fn resolve_fusion(hybrid: Option<&HybridConfig>) -> Result<Fusion> {
    let k = match hybrid.and_then(|config| config.k) {
        None => DEFAULT_RANK_CONSTANT,
        Some(k) if k.is_finite() && k.fract() == 0.0 && k >= MIN_RANK_CONSTANT => k,
        Some(_) => {
            return Err(config_invalid(format!(
                "hybrid.k must be a whole number of at least {MIN_RANK_CONSTANT}"
            )));
        }
    };
    let alpha = match hybrid.and_then(|config| config.alpha) {
        None => DEFAULT_LINEAR_ALPHA,
        Some(alpha)
            if alpha.is_finite() && (MIN_LINEAR_ALPHA..=MAX_LINEAR_ALPHA).contains(&alpha) =>
        {
            alpha
        }
        Some(_) => {
            return Err(config_invalid(format!(
                "hybrid.alpha must be a number from {MIN_LINEAR_ALPHA} to {MAX_LINEAR_ALPHA}"
            )));
        }
    };
    Ok(Fusion {
        strategy: hybrid
            .and_then(|config| config.strategy)
            .unwrap_or_default(),
        k,
        alpha,
    })
}

/// Returns the fixed depth of a hybrid query, or `None` where it pages by depth, raising `CONFIG_INVALID` for a
/// depth outside the range.
pub(crate) fn fixed_hybrid_depth(hybrid: Option<&HybridConfig>) -> Result<Option<usize>> {
    match hybrid.and_then(|config| config.depth) {
        None => Ok(None),
        Some(depth) if (MIN_HYBRID_DEPTH..=MAX_HYBRID_DEPTH).contains(&depth) => Ok(Some(depth)),
        Some(_) => Err(config_invalid(format!(
            "hybrid.depth must be a whole number from {MIN_HYBRID_DEPTH} to {MAX_HYBRID_DEPTH}"
        ))),
    }
}

/// Raises `SEARCH_RESULT_WINDOW_EXCEEDED` for a page of a fixed-depth hybrid query that starts at its depth or past
/// it.
pub(crate) fn require_within_hybrid_depth(
    cursor_depth: usize,
    offset: usize,
    depth: usize,
) -> Result<()> {
    let start = cursor_depth.saturating_add(offset);
    if start < depth {
        return Ok(());
    }
    Err(NarsilError::new(
        ErrorCode::SEARCH_RESULT_WINDOW_EXCEEDED,
        format!(
            "A hybrid query pages through the first {depth} fused results, and this page starts at {start}. Raise hybrid.depth to page further"
        ),
    ))
}

/// Orders fused hits best first, then by document ID in code point order.
pub(crate) fn fused_order(left: &KeywordHit, right: &KeywordHit) -> Ordering {
    score_then_id((left.score, &left.id), (right.score, &right.id))
}

/// Fuses ranked lists by reciprocal rank, adding 1 / (k + rank) for each list that holds a document.
pub(crate) fn reciprocal_rank_fusion(lists: [&[KeywordHit]; 2], k: f64) -> Vec<KeywordHit> {
    let mut positions: HashMap<&str, usize> = HashMap::new();
    let mut fused: Vec<KeywordHit> = Vec::new();
    for list in lists {
        for (rank, hit) in list.iter().enumerate() {
            let contribution = 1.0 / (k + rank as f64 + 1.0);
            match positions.get(hit.id.as_str()) {
                Some(&at) => {
                    if let Some(entry) = fused.get_mut(at) {
                        entry.score += contribution;
                    }
                }
                None => {
                    positions.insert(&hit.id, fused.len());
                    fused.push(KeywordHit {
                        id: hit.id.clone(),
                        score: contribution,
                        components: hit.components.clone(),
                    });
                }
            }
        }
    }
    fused.sort_by(fused_order);
    fused
}

fn min_max_normalised(hits: &[KeywordHit]) -> HashMap<&str, f64> {
    let Some(first) = hits.first() else {
        return HashMap::new();
    };
    let (mut low, mut high) = (first.score, first.score);
    for hit in hits {
        if hit.score < low {
            low = hit.score;
        }
        if hit.score > high {
            high = hit.score;
        }
    }
    let range = high - low;
    hits.iter()
        .map(|hit| {
            let score = if range == 0.0 {
                1.0
            } else {
                (hit.score - low) / range
            };
            (hit.id.as_str(), score)
        })
        .collect()
}

/// Fuses a text ranking and a vector ranking by a weighted sum of their min-max normalised scores, where `alpha`
/// weighs the vector side.
pub(crate) fn linear_combination(
    text: &[KeywordHit],
    vector: &[KeywordHit],
    alpha: f64,
) -> Vec<KeywordHit> {
    let text_scores = min_max_normalised(text);
    let vector_scores = min_max_normalised(vector);
    let mut seen: HashMap<&str, ()> = HashMap::with_capacity(text.len() + vector.len());
    let mut fused = Vec::with_capacity(text.len() + vector.len());
    for (hit, from_text) in text
        .iter()
        .map(|hit| (hit, true))
        .chain(vector.iter().map(|hit| (hit, false)))
    {
        if seen.insert(hit.id.as_str(), ()).is_some() {
            continue;
        }
        let text_score = text_scores.get(hit.id.as_str()).copied().unwrap_or(0.0);
        let vector_score = vector_scores.get(hit.id.as_str()).copied().unwrap_or(0.0);
        let components = match from_text {
            true => hit.components.clone(),
            false => Some(ScoreComponents::default()),
        };
        fused.push(KeywordHit {
            id: hit.id.clone(),
            score: alpha * vector_score + (1.0 - alpha) * text_score,
            components,
        });
    }
    fused.sort_by(fused_order);
    fused
}
