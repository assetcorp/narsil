use std::collections::HashMap;

use super::constants::{
    DEFAULT_LINEAR_ALPHA, DEFAULT_RANK_CONSTANT, MAX_HYBRID_DEPTH, MAX_LINEAR_ALPHA,
    MIN_HYBRID_DEPTH, MIN_LINEAR_ALPHA, MIN_RANK_CONSTANT,
};
use super::params::{HybridConfig, HybridStrategy};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::ffi;
use crate::native::status::{query_accepted, query_refused};
use crate::native::workspace::with_workspace;
use crate::search::components::ScoreComponents;
use crate::search::keyword::KeywordHit;
use crate::search::rankings::id_ranks;

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

const HYBRID_FUSION: &str = "a fusion of hybrid rankings";

struct Legs {
    entries: Vec<KeywordHit>,
    text_keys: Vec<u32>,
    text_scores: Vec<f64>,
    vector_keys: Vec<u32>,
    vector_scores: Vec<f64>,
}

fn keyed_legs(fusion: Fusion, text: &[KeywordHit], vector: &[KeywordHit]) -> Legs {
    let mut keys: HashMap<&str, u32> = HashMap::with_capacity(text.len() + vector.len());
    let mut entries = Vec::with_capacity(text.len() + vector.len());
    let mut text_keys = Vec::with_capacity(text.len());
    let mut vector_keys = Vec::with_capacity(vector.len());
    let sides = text
        .iter()
        .map(|hit| (hit, true))
        .chain(vector.iter().map(|hit| (hit, false)));
    for (hit, from_text) in sides {
        let next = entries.len() as u32;
        let key = *keys.entry(hit.id.as_str()).or_insert(next);
        if key == next {
            let components = match (fusion.strategy, from_text) {
                (HybridStrategy::Linear, false) => Some(ScoreComponents::default()),
                _ => hit.components.clone(),
            };
            entries.push(KeywordHit {
                id: hit.id.clone(),
                score: 0.0,
                components,
            });
        }
        match from_text {
            true => text_keys.push(key),
            false => vector_keys.push(key),
        }
    }
    Legs {
        entries,
        text_keys,
        text_scores: text.iter().map(|hit| hit.score).collect(),
        vector_keys,
        vector_scores: vector.iter().map(|hit| hit.score).collect(),
    }
}

fn leg_of(keys: &[u32], scores: &[f64]) -> ffi::narsil_fusion_leg {
    ffi::narsil_fusion_leg {
        keys: keys.as_ptr(),
        scores: scores.as_ptr(),
        count: keys.len() as u32,
    }
}

/// Fuses a text ranking and a vector ranking on the native core, by reciprocal rank or by a weighted sum of
/// normalised scores, best first and then by document ID in code point order.
pub(crate) fn fuse(
    fusion: Fusion,
    text: &[KeywordHit],
    vector: &[KeywordHit],
) -> Result<Vec<KeywordHit>> {
    let capacity = text.len() + vector.len();
    if u32::try_from(capacity).is_err() {
        return Err(query_refused(HYBRID_FUSION, ffi::NARSIL_INVALID_ARGUMENT));
    }
    let legs = keyed_legs(fusion, text, vector);
    let ranks = id_ranks(&legs.entries);
    let mut keys = vec![0u32; capacity];
    let mut scores = vec![0f64; capacity];
    let request = ffi::narsil_fusion_request {
        strategy: match fusion.strategy {
            HybridStrategy::Rrf => ffi::NARSIL_FUSION_RRF,
            HybridStrategy::Linear => ffi::NARSIL_FUSION_LINEAR,
        },
        rank_constant: fusion.k,
        alpha: fusion.alpha,
        text: leg_of(&legs.text_keys, &legs.text_scores),
        vector: leg_of(&legs.vector_keys, &legs.vector_scores),
        id_ranks: ranks.as_ptr(),
        key_count: ranks.len() as u32,
    };
    let mut output = ffi::narsil_fusion_output {
        keys: keys.as_mut_ptr(),
        scores: scores.as_mut_ptr(),
        capacity: capacity as u32,
        count: 0,
    };
    let status = with_workspace(|workspace| {
        Ok(unsafe { ffi::narsil_fuse(workspace, &request, &mut output) })
    })?;
    query_accepted(HYBRID_FUSION, status)?;
    let found = output.count as usize;
    let mut held: Vec<Option<KeywordHit>> = legs.entries.into_iter().map(Some).collect();
    let mut fused = Vec::with_capacity(found);
    for (&key, &score) in keys.iter().zip(&scores).take(found) {
        if let Some(mut hit) = held.get_mut(key as usize).and_then(Option::take) {
            hit.score = score;
            fused.push(hit);
        }
    }
    Ok(fused)
}
