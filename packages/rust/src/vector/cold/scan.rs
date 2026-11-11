use std::cmp::Ordering;

use crate::error::Result;
use crate::pins::LOADED_SEQUENCE;
use crate::search::rankings::score_order;

use super::super::constants::SCORE_CHUNK_VECTORS;
use super::super::core::Scratch;
use super::super::ranking::{VectorHit, best_first};
use super::super::search::VectorSearchOptions;
use super::super::settings::{metric_code, to_score};
use super::super::store::{StoreTables, magnitude_of};
use super::field::ColdField;

const MIN_SCORES_HELD_BEFORE_TRIM: usize = 64;

fn best_score_first(left: &(f64, u32), right: &(f64, u32)) -> Ordering {
    score_order(left.0, right.0)
}

fn keep_through_place(scored: &mut Vec<(f64, u32)>, k: usize) {
    if k == 0 {
        scored.clear();
        return;
    }
    if scored.len() <= k {
        return;
    }
    scored.select_nth_unstable_by(k - 1, best_score_first);
    let last_kept = scored[k - 1].0;
    scored.retain(|entry| score_order(entry.0, last_kept) != Ordering::Greater);
}

pub(super) fn ranked_by_id(
    field: &ColdField,
    mut scored: Vec<(f64, u32)>,
    k: usize,
) -> Result<Vec<VectorHit>> {
    keep_through_place(&mut scored, k);
    let mut hits = Vec::with_capacity(scored.len());
    for (score, number) in scored {
        hits.push(VectorHit {
            doc_id: field.id_at(number)?,
            score,
            ordinal: number,
        });
    }
    hits.sort_by(|left, right| {
        best_first(
            (left.score, left.doc_id.as_str()),
            (right.score, right.doc_id.as_str()),
        )
    });
    hits.truncate(k);
    Ok(hits)
}

pub(super) struct FileScan<'a> {
    pub(super) field: &'a ColdField,
    pub(super) query: &'a [f32],
    pub(super) options: &'a VectorSearchOptions,
    pub(super) k: usize,
}

pub(super) fn scan_numbers(
    scratch: &mut Scratch,
    request: &FileScan<'_>,
    numbers: &[u32],
) -> Result<(Vec<VectorHit>, u64)> {
    let field = request.field;
    let metric = request.options.metric;
    let floor = request.options.min_similarity;
    let group_size = numbers.len().min(SCORE_CHUNK_VECTORS);
    if group_size == 0 {
        return Ok((Vec::new(), 0));
    }
    let store = StoreTables::new(field.dimension(), 0, group_size, None);
    let slots: Vec<i32> = (0..group_size as i32).collect();
    let mut vector = vec![0f32; field.dimension()];
    let mut scored: Vec<(f64, u32)> = Vec::new();
    let mut matched = 0u64;
    let trim_above = request.k.saturating_mul(2).max(MIN_SCORES_HELD_BEFORE_TRIM);
    for group in numbers.chunks(group_size) {
        for (slot, &number) in group.iter().enumerate() {
            field.vector_into(number, &mut vector)?;
            store.write_vector(slot as u32, &vector, magnitude_of(&vector));
            store.set_present(slot as u32, true);
            store.stamp_born(slot as u32, LOADED_SEQUENCE);
        }
        store.set_slots(group.len() as u32);
        scratch.score(
            &store,
            request.query,
            metric_code(metric),
            &slots[..group.len()],
            LOADED_SEQUENCE,
        )?;
        for (at, &number) in group.iter().enumerate() {
            let distance = scratch.scores[at];
            if distance == f64::INFINITY {
                continue;
            }
            let score = to_score(distance, metric);
            if score < floor {
                continue;
            }
            matched += 1;
            scored.push((score, number));
        }
        if scored.len() >= trim_above {
            keep_through_place(&mut scored, request.k);
        }
    }
    Ok((ranked_by_id(field, scored, request.k)?, matched))
}
