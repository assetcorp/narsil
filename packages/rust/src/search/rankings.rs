use std::cmp::Ordering;

use crate::error::{ErrorCode, NarsilError, Result};
use crate::ffi;
use crate::keyword::workspace::with_workspace;

pub(crate) trait RankedEntry {
    fn ranking_score(&self) -> f64;
    fn ranking_id(&self) -> &str;
}

pub(crate) fn score_order(left: f64, right: f64) -> Ordering {
    match (left.is_nan(), right.is_nan()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => right.partial_cmp(&left).unwrap_or(Ordering::Equal),
    }
}

pub(crate) fn score_then_id(left: (f64, &str), right: (f64, &str)) -> Ordering {
    score_order(left.0, right.0).then_with(|| left.1.cmp(right.1))
}

fn exceeds_layout() -> NarsilError {
    NarsilError::new(
        ErrorCode::CONFIG_INVALID,
        "The search rankings or limit exceed the merge layout",
    )
}

pub(crate) fn id_ranks<T: RankedEntry>(entries: &[T]) -> Vec<u32> {
    let mut order: Vec<usize> = (0..entries.len()).collect();
    order.sort_by(|&left, &right| entries[left].ranking_id().cmp(entries[right].ranking_id()));
    let mut ranks = vec![0u32; entries.len()];
    let mut rank = 0u32;
    for (place, &at) in order.iter().enumerate() {
        if place > 0 && entries[order[place - 1]].ranking_id() != entries[at].ranking_id() {
            rank += 1;
        }
        ranks[at] = rank;
    }
    ranks
}

pub(crate) fn merge_rankings<T: RankedEntry>(
    lists: Vec<Vec<T>>,
    limit: Option<usize>,
) -> Result<Vec<T>> {
    if lists.iter().filter(|list| !list.is_empty()).count() <= 1 {
        let mut only = lists
            .into_iter()
            .find(|list| !list.is_empty())
            .unwrap_or_default();
        if let Some(limit) = limit {
            only.truncate(limit);
        }
        return Ok(only);
    }
    let count: usize = lists.iter().map(Vec::len).sum();
    if u32::try_from(count).is_err() || u32::try_from(lists.len()).is_err() {
        return Err(exceeds_layout());
    }
    let wanted = limit.unwrap_or(count).min(count);
    let mut offsets = Vec::with_capacity(lists.len() + 1);
    let mut position = 0u32;
    for list in &lists {
        offsets.push(position);
        position += list.len() as u32;
    }
    offsets.push(position);
    let entries: Vec<T> = lists.into_iter().flatten().collect();
    let scores: Vec<f64> = entries.iter().map(RankedEntry::ranking_score).collect();
    let ranks = id_ranks(&entries);
    let places = merged_places(&offsets, Some(&scores), &ranks, wanted)?;
    let mut held: Vec<Option<T>> = entries.into_iter().map(Some).collect();
    let mut merged = Vec::with_capacity(places.len());
    for at in places {
        if let Some(entry) = held.get_mut(at).and_then(Option::take) {
            merged.push(entry);
        }
    }
    Ok(merged)
}

fn merged_places(
    offsets: &[u32],
    scores: Option<&[f64]>,
    ranks: &[u32],
    wanted: usize,
) -> Result<Vec<usize>> {
    let limit = u32::try_from(wanted).map_err(|_| exceeds_layout())?;
    let mut sources = vec![0u32; wanted];
    let mut indices = vec![0u32; wanted];
    let held_scores = scores.unwrap_or(&[]);
    let request = ffi::narsil_merge_request {
        offsets: offsets.as_ptr(),
        offset_count: offsets.len(),
        scores: held_scores.as_ptr(),
        score_count: held_scores.len(),
        ranks: ranks.as_ptr(),
        rank_count: ranks.len(),
        limit,
    };
    let mut output = ffi::narsil_merge_output {
        lists: sources.as_mut_ptr(),
        list_capacity: sources.len(),
        indices: indices.as_mut_ptr(),
        index_capacity: indices.len(),
        count: 0,
    };
    let status = with_workspace(|workspace| {
        Ok(unsafe {
            match scores {
                Some(_) => ffi::narsil_merge_rankings(workspace, &request, &mut output),
                None => ffi::narsil_merge_sorted(workspace, &request, &mut output),
            }
        })
    })?;
    if status != ffi::NARSIL_OK {
        return Err(NarsilError::new(
            ErrorCode::CONFIG_INVALID,
            format!(
                "The search rankings cannot be merged, as the native core returned status {status}"
            ),
        ));
    }
    Ok(sources
        .iter()
        .zip(&indices)
        .take(output.count as usize)
        .map(|(&source, &index)| offsets[source as usize] as usize + index as usize)
        .collect())
}

pub(crate) fn merge_sorted(bounds: &[usize], ranks: &[u32], limit: usize) -> Result<Vec<usize>> {
    let count = ranks.len();
    if u32::try_from(count).is_err() || bounds.last().copied() != Some(count) {
        return Err(exceeds_layout());
    }
    let mut listed: Vec<usize> = (0..count).collect();
    for list in bounds.windows(2) {
        listed[list[0]..list[1]].sort_unstable_by_key(|&at| ranks[at]);
    }
    let offsets: Vec<u32> = bounds.iter().map(|&bound| bound as u32).collect();
    let listed_ranks: Vec<u32> = listed.iter().map(|&at| ranks[at]).collect();
    let places = merged_places(&offsets, None, &listed_ranks, limit.min(count))?;
    Ok(places.into_iter().map(|place| listed[place]).collect())
}
