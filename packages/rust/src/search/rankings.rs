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

fn id_ranks<T: RankedEntry>(entries: &[T]) -> Vec<u32> {
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
    let mut sources = vec![0u32; wanted];
    let mut indices = vec![0u32; wanted];
    let request = ffi::narsil_merge_request {
        offsets: offsets.as_ptr(),
        offset_count: offsets.len(),
        scores: scores.as_ptr(),
        score_count: scores.len(),
        ranks: ranks.as_ptr(),
        rank_count: ranks.len(),
        limit: wanted as u32,
    };
    let mut output = ffi::narsil_merge_output {
        lists: sources.as_mut_ptr(),
        list_capacity: sources.len(),
        indices: indices.as_mut_ptr(),
        index_capacity: indices.len(),
        count: 0,
    };
    let status = with_workspace(|workspace| {
        Ok(unsafe { ffi::narsil_merge_rankings(workspace, &request, &mut output) })
    })?;
    if status != ffi::NARSIL_OK {
        return Err(NarsilError::new(
            ErrorCode::CONFIG_INVALID,
            format!(
                "The search rankings cannot be merged, as the native core returned status {status}"
            ),
        ));
    }
    let found = output.count as usize;
    let mut held: Vec<Option<T>> = entries.into_iter().map(Some).collect();
    let mut merged = Vec::with_capacity(found);
    for (&source, &index) in sources.iter().zip(&indices).take(found) {
        let at = offsets[source as usize] as usize + index as usize;
        if let Some(entry) = held.get_mut(at).and_then(Option::take) {
            merged.push(entry);
        }
    }
    Ok(merged)
}
