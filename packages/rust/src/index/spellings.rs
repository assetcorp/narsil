use std::collections::HashMap;

use super::constants::PARTIAL_WORD_RUN_CODE_POINTS;

const RUN_CODE_POINT_BITS: u32 = 21;

/// One spelling that the documents of a segment wrote in a partial-word field, with the index token that it
/// analyses to and how often it occurs.
pub(crate) struct SpellingEntry {
    pub(crate) spelling: String,
    pub(crate) token: String,
    pub(crate) count: u64,
    pub(crate) length: usize,
}

/// The spellings of a segment's partial-word fields, with an index from every run of three code points to the
/// spellings that hold it, so that a search finds the spellings that contain a fragment without reading them all.
#[derive(Default)]
pub(crate) struct StoredSpellings {
    entries: Vec<SpellingEntry>,
    slots: HashMap<String, Vec<u32>>,
    runs: HashMap<u64, Vec<u32>>,
}

fn run_key(points: &[char]) -> u64 {
    points.iter().fold(0u64, |key, &point| {
        (key << RUN_CODE_POINT_BITS) | u64::from(u32::from(point))
    })
}

impl StoredSpellings {
    /// Adds `count` occurrences of `spelling` under `token`, ignoring a spelling too short to hold a run.
    pub(crate) fn add(&mut self, spelling: &str, token: &str, count: u64) {
        if count == 0 || token.is_empty() {
            return;
        }
        let points: Vec<char> = spelling.chars().collect();
        if points.len() <= PARTIAL_WORD_RUN_CODE_POINTS {
            return;
        }
        let entries = &mut self.entries;
        let slot = self.slots.entry(spelling.to_string()).or_default();
        if let Some(&at) = slot.iter().find(|&&at| entries[at as usize].token == token) {
            entries[at as usize].count += count;
            return;
        }
        let Ok(at) = u32::try_from(entries.len()) else {
            return;
        };
        slot.push(at);
        entries.push(SpellingEntry {
            spelling: spelling.to_string(),
            token: token.to_string(),
            count,
            length: points.len(),
        });
        for run in points.windows(PARTIAL_WORD_RUN_CODE_POINTS) {
            let members = self.runs.entry(run_key(run)).or_default();
            if members.last() != Some(&at) {
                members.push(at);
            }
        }
    }

    /// Visits each spelling longer than `fragment` that contains it and that `live` accepts.
    pub(crate) fn visit_containing(
        &self,
        fragment: &str,
        live: &dyn Fn(&SpellingEntry) -> bool,
        visit: &mut dyn FnMut(&SpellingEntry),
    ) {
        let points: Vec<char> = fragment.chars().collect();
        if points.len() < PARTIAL_WORD_RUN_CODE_POINTS {
            return;
        }
        let mut narrowest: Option<&Vec<u32>> = None;
        for run in points.windows(PARTIAL_WORD_RUN_CODE_POINTS) {
            let Some(members) = self.runs.get(&run_key(run)) else {
                return;
            };
            if narrowest.is_none_or(|held| members.len() < held.len()) {
                narrowest = Some(members);
            }
        }
        let Some(members) = narrowest else {
            return;
        };
        for &at in members {
            let Some(entry) = self.entries.get(at as usize) else {
                continue;
            };
            if entry.length > points.len() && entry.spelling.contains(fragment) && live(entry) {
                visit(entry);
            }
        }
    }

    /// Returns every stored spelling with its token and its count, in the order that the segment first met them.
    pub(crate) fn entries(&self) -> &[SpellingEntry] {
        &self.entries
    }
}
