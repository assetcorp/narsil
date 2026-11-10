use std::cmp::Ordering;
use std::collections::HashSet;

use crate::engine::query::pagination::deduped_pins;
use crate::engine::query::params::Pin;
use crate::engine::query::results::Hit;

pub(crate) struct Reordered {
    pub(crate) hits: Vec<Hit>,
    pub(crate) shared_ids: HashSet<String>,
}

fn score_of(hit: &Hit) -> f64 {
    hit.score.unwrap_or(0.0)
}

fn rerank_order(left: &Hit, right: &Hit) -> Ordering {
    let difference = score_of(right) - score_of(left);
    match difference.partial_cmp(&0.0) {
        Some(Ordering::Equal) | None => left.id.cmp(&right.id),
        Some(order) => order,
    }
}

pub(crate) fn unordered(ranked: Vec<Hit>) -> Reordered {
    let shared_ids = ranked.iter().map(|hit| hit.id.clone()).collect();
    Reordered {
        hits: ranked,
        shared_ids,
    }
}

pub(crate) fn reorder_by_rerank(
    mut ranked: Vec<Hit>,
    window_size: usize,
    scores: &[f64],
) -> Reordered {
    let tail = ranked.split_off(window_size.min(ranked.len()));
    let mut initial_low = f64::INFINITY;
    let mut initial_high = f64::NEG_INFINITY;
    let mut final_low = f64::INFINITY;
    let mut final_high = f64::NEG_INFINITY;
    for (hit, &score) in ranked.iter_mut().zip(scores) {
        let first = score_of(hit);
        if first < initial_low {
            initial_low = first;
        }
        if first > initial_high {
            initial_high = first;
        }
        if score < final_low {
            final_low = score;
        }
        if score > final_high {
            final_high = score;
        }
        hit.score = Some(score);
    }
    ranked.sort_by(rerank_order);
    let rescale = initial_low > final_low;
    let scale = match rescale {
        true => (final_high - final_low).max(1.0) / (initial_high - initial_low).max(1.0),
        false => 1.0,
    };
    let bias = match rescale {
        true => final_low - initial_low * scale,
        false => 0.0,
    };
    let shared_ids = match rescale {
        true => HashSet::new(),
        false => tail.iter().map(|hit| hit.id.clone()).collect(),
    };
    ranked.extend(tail.into_iter().map(|mut hit| {
        if rescale {
            hit.score = Some(score_of(&hit) * scale + bias);
        }
        hit
    }));
    Reordered {
        hits: ranked,
        shared_ids,
    }
}

pub(crate) fn place_pins(hits: &[Hit], pins: Option<&[Pin]>) -> Vec<Hit> {
    let mut placed = hits.to_vec();
    let Some(pins) = pins else {
        return placed;
    };
    let mut deduped = deduped_pins(pins);
    let pinned_ids: HashSet<&str> = deduped.iter().map(|pin| pin.doc_id.as_str()).collect();
    placed.retain(|hit| !pinned_ids.contains(hit.id.as_str()));
    deduped.sort_by_key(|pin| pin.position);
    for pin in deduped {
        let at = pin.position.min(placed.len());
        placed.insert(
            at,
            Hit {
                id: pin.doc_id.clone(),
                score: Some(0.0),
                ..Hit::default()
            },
        );
    }
    placed
}
