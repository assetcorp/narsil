use std::collections::{BTreeMap, HashMap, HashSet};

use super::constants::{
    KEY_FINGERPRINT_BYTES, MERGE_ENTRY_OVERHEAD_BYTES, MERGE_SLOT_OVERHEAD_BYTES,
    SCRAMBLED_ID_BYTES,
};
use super::counts_file::{OpenedCountsFile, open_counts_file};
use super::scramble::ScrambledId;
use crate::error::{ErrorCode, NarsilError, Result};

/// The limits of one merge, which the setting of the index sets.
pub(crate) struct MergeSettings {
    pub(crate) min_people: usize,
    pub(crate) max_merge_phrases: usize,
    pub(crate) max_groups: usize,
    pub(crate) marked_groups: Vec<String>,
    pub(crate) banned: HashSet<String>,
    pub(crate) memory_bytes: u64,
    pub(crate) fingerprint: [u8; KEY_FINGERPRINT_BYTES],
}

/// What merging one history file did.
pub(crate) enum FileOutcome {
    Merged { day: String, saved_at: u64 },
    Damaged,
    OtherKey,
}

/// One phrase that enough people searched, with the sum of its counts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DuePhrase {
    pub(crate) phrase: String,
    pub(crate) count: u64,
}

/// The due phrases of each group, most searched first, and the number of phrases that the limits left out.
#[derive(Debug, Default)]
pub(crate) struct MergeResult {
    pub(crate) groups: BTreeMap<String, Vec<DuePhrase>>,
    pub(crate) discarded: u64,
}

struct Entry {
    count: u64,
    people: Option<HashSet<ScrambledId>>,
}

type EntryKey = (Box<str>, Box<str>);

/// Merges the history files of one index, counting the memory that it holds so that it fails with
/// `WORKER_ACTION_FAILED` before it passes `mergeMemoryBytes`.
pub(crate) struct Merger {
    settings: MergeSettings,
    entries: HashMap<EntryKey, Entry>,
    groups: HashSet<String>,
    text_bytes: u64,
    people_slots: u64,
    discarded: u64,
}

fn memory_exceeded(limit: u64) -> NarsilError {
    NarsilError::new(
        ErrorCode::WORKER_ACTION_FAILED,
        format!(
            "The query suggestions merge failed: it needs more than the {limit} bytes that mergeMemoryBytes allows"
        ),
    )
}

/// Orders two strings by their UTF-16 code units, as every Narsil implementation orders phrases.
pub(crate) fn compare_utf16(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

impl Merger {
    /// Returns an empty merge that keeps within `settings`.
    pub(crate) fn new(settings: MergeSettings) -> Merger {
        let groups = settings.marked_groups.iter().cloned().collect();
        Merger {
            settings,
            entries: HashMap::new(),
            groups,
            text_bytes: 0,
            people_slots: 0,
            discarded: 0,
        }
    }

    fn held_bytes(&self) -> u64 {
        (self.entries.capacity() as u64)
            .saturating_mul(MERGE_ENTRY_OVERHEAD_BYTES)
            .saturating_add(self.text_bytes)
            .saturating_add(
                self.people_slots
                    .saturating_mul(SCRAMBLED_ID_BYTES as u64 + MERGE_SLOT_OVERHEAD_BYTES),
            )
    }

    fn require_within(&self, extra: u64) -> Result<()> {
        if self.held_bytes().saturating_add(extra) > self.settings.memory_bytes {
            return Err(memory_exceeded(self.settings.memory_bytes));
        }
        Ok(())
    }

    /// Merges one history file of `expected_day`, reporting a file that is damaged or under another key.
    pub(crate) fn add_file(&mut self, bytes: &[u8], expected_day: &str) -> Result<FileOutcome> {
        self.require_within(bytes.len() as u64)?;
        let fingerprint = self.settings.fingerprint;
        let opened = match open_counts_file(bytes, Some(expected_day), &fingerprint) {
            OpenedCountsFile::Counts(opened) => opened,
            OpenedCountsFile::Damaged(_) => return Ok(FileOutcome::Damaged),
            OpenedCountsFile::OtherKey => return Ok(FileOutcome::OtherKey),
        };
        opened.visit(&mut |visited| {
            self.merge_phrase(visited.group, visited.phrase, visited.count, visited.people)
        })?;
        Ok(FileOutcome::Merged {
            day: opened.day.clone(),
            saved_at: opened.saved_at,
        })
    }

    fn merge_phrase(
        &mut self,
        group: &str,
        phrase: &str,
        count: u64,
        people: &[ScrambledId],
    ) -> Result<()> {
        if self.settings.banned.contains(phrase) {
            return Ok(());
        }
        let key: EntryKey = (group.into(), phrase.into());
        if !self.entries.contains_key(&key) {
            let new_group = !self.groups.contains(group);
            if (new_group && self.groups.len() >= self.settings.max_groups)
                || self.entries.len() >= self.settings.max_merge_phrases
            {
                self.discarded += 1;
                return Ok(());
            }
            let text = (group.len() + phrase.len()) as u64;
            self.require_within(text.saturating_add(MERGE_ENTRY_OVERHEAD_BYTES))?;
            if new_group {
                self.groups.insert(group.to_string());
            }
            self.text_bytes += text;
            self.entries.insert(
                key.clone(),
                Entry {
                    count: 0,
                    people: Some(HashSet::new()),
                },
            );
            self.require_within(0)?;
        }
        let min_people = self.settings.min_people;
        let Some(entry) = self.entries.get_mut(&key) else {
            return Ok(());
        };
        entry.count = entry.count.saturating_add(count);
        let Some(set) = entry.people.as_mut() else {
            return Ok(());
        };
        let before = set.capacity() as u64;
        let mut reached = false;
        for person in people {
            set.insert(*person);
            if set.len() >= min_people {
                reached = true;
                break;
            }
        }
        let after = set.capacity() as u64;
        if reached {
            entry.people = None;
            self.people_slots = self.people_slots.saturating_sub(before);
        } else {
            self.people_slots = self
                .people_slots
                .saturating_sub(before)
                .saturating_add(after);
        }
        self.require_within(0)
    }

    /// Returns the due phrases of each group, most searched first and then in UTF-16 order.
    pub(crate) fn result(self) -> MergeResult {
        let mut groups: BTreeMap<String, Vec<DuePhrase>> = BTreeMap::new();
        for ((group, phrase), entry) in self.entries {
            if entry.people.is_some() {
                continue;
            }
            groups.entry(group.into()).or_default().push(DuePhrase {
                phrase: phrase.into(),
                count: entry.count,
            });
        }
        for list in groups.values_mut() {
            list.sort_by(|left, right| {
                right
                    .count
                    .cmp(&left.count)
                    .then_with(|| compare_utf16(&left.phrase, &right.phrase))
            });
        }
        MergeResult {
            groups,
            discarded: self.discarded,
        }
    }
}
