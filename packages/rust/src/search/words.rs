use std::collections::{BTreeSet, HashSet};
use std::ops::Bound;

use super::lookup::live_document_frequency;
use crate::error::Result;
use crate::index::partition::PartitionSnapshot;
use crate::index::segment::{SegmentData, SegmentEntry};

fn live_total_frequency(entry: &SegmentEntry, token: &str) -> Result<u64> {
    let stored = match &entry.data {
        SegmentData::Frozen(segment) => match segment.term_index(token) {
            Some(at) => segment.term_total(at)?,
            None => 0,
        },
        SegmentData::Tail(tail) => tail.terms.get(token).map_or(0, |term| term.total_frequency),
    };
    let removed = entry
        .removed_words
        .occurrences
        .get(token)
        .copied()
        .unwrap_or(0);
    Ok(stored.saturating_sub(removed))
}

fn stem_changed_total(entry: &SegmentEntry, token: &str) -> u64 {
    let stored = entry
        .stored_surfaces()
        .totals
        .get(token)
        .copied()
        .unwrap_or(0);
    let removed = entry
        .removed_words
        .surface_totals
        .get(token)
        .copied()
        .unwrap_or(0);
    stored.saturating_sub(removed)
}

/// Returns how often `token` occurs in the segment's live documents as an index token that stemming left alone.
pub(crate) fn verbatim_occurrences(entry: &SegmentEntry, token: &str) -> Result<u64> {
    Ok(live_total_frequency(entry, token)?.saturating_sub(stem_changed_total(entry, token)))
}

/// Returns the number of surface forms that the segment's live documents hold.
pub(crate) fn live_surface_count(entry: &SegmentEntry) -> usize {
    entry
        .stored_surfaces()
        .entries
        .len()
        .saturating_sub(entry.removed_words.emptied_surfaces)
}

/// Visits each surface form of the segment's live documents that starts with `prefix`, with its token and count.
pub(crate) fn visit_surfaces_with_prefix(
    entry: &SegmentEntry,
    prefix: &str,
    visit: &mut dyn FnMut(&str, &str, u64),
) {
    if prefix.is_empty() {
        return;
    }
    let range = entry
        .stored_surfaces()
        .entries
        .range::<str, _>((Bound::Included(prefix), Bound::Unbounded))
        .take_while(|(surface, _)| surface.starts_with(prefix));
    for (surface, (token, stored)) in range {
        let count = entry.removed_words.surface_count(surface, *stored);
        if count > 0 {
            visit(surface, token, count);
        }
    }
}

/// Visits each index token of the segment that starts with `prefix` and that a live document holds.
pub(crate) fn visit_tokens_with_prefix(
    entry: &SegmentEntry,
    prefix: &str,
    visit: &mut dyn FnMut(&str),
) {
    if prefix.is_empty() {
        return;
    }
    match &entry.data {
        SegmentData::Frozen(segment) => {
            for at in segment.prefix_range(prefix) {
                let token = segment.token(at);
                if live_document_frequency(entry, token) > 0 {
                    visit(token);
                }
            }
        }
        SegmentData::Tail(tail) => {
            let range = tail
                .terms
                .range::<str, _>((Bound::Included(prefix), Bound::Unbounded))
                .take_while(|(token, _)| token.starts_with(prefix));
            for (token, _) in range {
                if live_document_frequency(entry, token) > 0 {
                    visit(token);
                }
            }
        }
    }
}

/// Returns the number of the partition's live documents that hold `token`.
pub(crate) fn partition_document_frequency(snapshot: &PartitionSnapshot, token: &str) -> u64 {
    snapshot
        .segments
        .iter()
        .map(|entry| live_document_frequency(entry, token))
        .sum()
}

/// Returns up to `limit` index tokens that complete `surface_prefix`, the unstemmed prefix that the query wrote,
/// most frequent first and then in code point order.
pub(crate) fn expand_term_prefix(
    snapshot: &PartitionSnapshot,
    surface_prefix: &str,
    stemmed_token: &str,
    limit: usize,
) -> Result<Vec<String>> {
    if limit == 0 || surface_prefix.is_empty() {
        return Ok(Vec::new());
    }
    let holds_surface_forms = snapshot
        .segments
        .iter()
        .any(|entry| live_surface_count(entry) > 0);
    let mut prefixes = vec![surface_prefix];
    if !holds_surface_forms && stemmed_token != surface_prefix && !stemmed_token.is_empty() {
        prefixes.push(stemmed_token);
    }
    let mut candidates: HashSet<String> = HashSet::new();
    for entry in &snapshot.segments {
        visit_surfaces_with_prefix(entry, surface_prefix, &mut |_, token, _| {
            candidates.insert(token.to_string());
        });
        for prefix in &prefixes {
            let mut found = Vec::new();
            visit_tokens_with_prefix(entry, prefix, &mut |token| {
                if !candidates.contains(token) {
                    found.push(token.to_string());
                }
            });
            for token in found {
                if verbatim_occurrences(entry, &token)? > 0 {
                    candidates.insert(token);
                }
            }
        }
    }
    let mut ranked: BTreeSet<(std::cmp::Reverse<u64>, String)> = BTreeSet::new();
    for token in candidates {
        let documents = partition_document_frequency(snapshot, &token);
        if documents > 0 {
            ranked.insert((std::cmp::Reverse(documents), token));
        }
    }
    Ok(ranked
        .into_iter()
        .take(limit)
        .map(|(_, token)| token)
        .collect())
}
