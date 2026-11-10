use std::collections::{BTreeMap, HashMap};

use super::indexed::IndexedDocument;

/// The surface forms of one segment as its writer stored them: each surface with its index token and its count,
/// the summed count of the surfaces of each token, and the surfaces in the order that the writer first met them,
/// where the slot of a surface is its place in that order.
#[derive(Debug, Default)]
pub(crate) struct StoredSurfaces {
    pub(crate) entries: BTreeMap<String, (String, u64)>,
    pub(crate) totals: HashMap<String, u64>,
    pub(crate) first_met: Vec<String>,
    slots: HashMap<String, u32>,
}

impl StoredSurfaces {
    /// Adds `count` occurrences of `surface` under `token` and returns the slot of the surface, or `None` where the
    /// surface is empty, equals its token, or holds no occurrence.
    pub(crate) fn add(&mut self, surface: &str, token: &str, count: u64) -> Option<u32> {
        if surface.is_empty() || token.is_empty() || count == 0 || surface == token {
            return None;
        }
        let slot = match self.slots.get(surface) {
            Some(&slot) => slot,
            None => {
                let slot = u32::try_from(self.first_met.len()).ok()?;
                self.first_met.push(surface.to_string());
                self.slots.insert(surface.to_string(), slot);
                slot
            }
        };
        let entry = self
            .entries
            .entry(surface.to_string())
            .or_insert_with(|| (token.to_string(), 0));
        entry.1 += count;
        *self.totals.entry(entry.0.clone()).or_insert(0) += count;
        Some(slot)
    }
}

/// What the removals from one segment took out of its word counts, so that a search reads the counts of its live
/// documents alone.
#[derive(Clone, Debug, Default)]
pub(crate) struct RemovedWords {
    pub(crate) occurrences: HashMap<String, u64>,
    pub(crate) documents: HashMap<String, u64>,
    pub(crate) surfaces: HashMap<String, u64>,
    pub(crate) surface_totals: HashMap<String, u64>,
    pub(crate) emptied_surfaces: usize,
    pub(crate) spellings: HashMap<String, Vec<(String, u64)>>,
}

impl RemovedWords {
    /// Takes the words of one removed document out of the counts of a segment whose stored surfaces are `stored`.
    pub(crate) fn record(&mut self, removed: &IndexedDocument, stored: &StoredSurfaces) {
        for field in &removed.text {
            for occurrence in &field.terms {
                *self.occurrences.entry(occurrence.term.clone()).or_insert(0) +=
                    u64::from(occurrence.frequency);
            }
        }
        self.record_surfaces(removed, stored);
    }

    /// Takes one removed document's tokens out of the counts of a paged segment, each with the summed term
    /// frequency that the segment's removal entry gives it, so that a search reads the live document frequency
    /// of a token without reading its postings.
    pub(crate) fn record_entry_terms(&mut self, terms: Vec<(String, u64)>) {
        for (token, occurrences) in terms {
            *self.occurrences.entry(token.clone()).or_insert(0) += occurrences;
            *self.documents.entry(token).or_insert(0) += 1;
        }
    }

    /// Takes the surface forms and written spellings of one removed document out of the counts of a segment
    /// whose stored surfaces are `stored`.
    pub(crate) fn record_surfaces(&mut self, removed: &IndexedDocument, stored: &StoredSurfaces) {
        for entry in &removed.surfaces {
            let Some((token, held)) = stored.entries.get(&entry.surface) else {
                continue;
            };
            let before = self.surfaces.get(&entry.surface).copied().unwrap_or(0);
            let left = held.saturating_sub(before);
            let taken = u64::from(entry.count).min(left);
            if taken == 0 {
                continue;
            }
            self.surfaces.insert(entry.surface.clone(), before + taken);
            *self.surface_totals.entry(token.clone()).or_insert(0) += taken;
            if taken == left {
                self.emptied_surfaces += 1;
            }
        }
        for entry in &removed.spellings {
            let tokens = self.spellings.entry(entry.spelling.clone()).or_default();
            match tokens.iter_mut().find(|(token, _)| *token == entry.token) {
                Some((_, count)) => *count += u64::from(entry.count),
                None => tokens.push((entry.token.clone(), u64::from(entry.count))),
            }
        }
    }

    pub(crate) fn surface_count(&self, surface: &str, stored: u64) -> u64 {
        stored.saturating_sub(self.surfaces.get(surface).copied().unwrap_or(0))
    }

    pub(crate) fn spelling_count(&self, spelling: &str, token: &str, stored: u64) -> u64 {
        let removed = self
            .spellings
            .get(spelling)
            .and_then(|tokens| tokens.iter().find(|(held, _)| held == token))
            .map_or(0, |(_, count)| *count);
        stored.saturating_sub(removed)
    }
}
