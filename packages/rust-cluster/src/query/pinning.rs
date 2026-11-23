use std::collections::HashSet;

use narsil::Pin;
use narsil::coordination::{PinnedPlace, place_pins};

use super::search_answer::ScoredEntry;
use crate::error::ClusterResult;

pub(crate) fn last_organic_entry<'a>(
    page: &'a [ScoredEntry],
    pinned: Option<&[Pin]>,
) -> Option<&'a ScoredEntry> {
    let Some(pinned) = pinned else {
        return page.last();
    };
    let pinned_ids: HashSet<&str> = pinned.iter().map(|pin| pin.doc_id.as_str()).collect();
    page.iter()
        .rev()
        .find(|entry| !pinned_ids.contains(entry.doc_id.as_str()))
}

pub(crate) struct PinnedPlacement {
    pub(crate) entries: Vec<ScoredEntry>,
    pub(crate) placed_from_outside: Vec<String>,
}

pub(crate) fn place_pinned_entries(
    merged: Vec<ScoredEntry>,
    pinned: &[Pin],
    depth: usize,
    all_matches_present: bool,
    stored: Option<&HashSet<String>>,
) -> ClusterResult<PinnedPlacement> {
    let kept: Vec<Pin> = match stored {
        None => pinned.to_vec(),
        Some(stored) => pinned
            .iter()
            .filter(|pin| stored.contains(&pin.doc_id))
            .cloned()
            .collect(),
    };
    let ranked_ids: Vec<String> = merged.iter().map(|entry| entry.doc_id.clone()).collect();
    let placement = place_pins(&ranked_ids, &kept, (!all_matches_present).then_some(depth))?;
    let mut entries = Vec::with_capacity(placement.order.len());
    let mut placed_from_outside = Vec::new();
    for place in placement.order {
        match place {
            PinnedPlace::Ranked(at) => {
                if let Some(entry) = merged.get(at) {
                    entries.push(entry.clone());
                }
            }
            PinnedPlace::Pin(pin) => {
                let Some(entry) = placement.pins.get(pin) else {
                    continue;
                };
                let organic = placement
                    .ranked
                    .get(pin)
                    .copied()
                    .flatten()
                    .and_then(|at| merged.get(at));
                if organic.is_none() {
                    placed_from_outside.push(entry.doc_id.clone());
                }
                entries.push(ScoredEntry {
                    doc_id: entry.doc_id.clone(),
                    score: Some(0.0),
                    sort_values: organic.and_then(|organic| organic.sort_values.clone()),
                });
            }
        }
    }
    Ok(PinnedPlacement {
        entries,
        placed_from_outside,
    })
}
