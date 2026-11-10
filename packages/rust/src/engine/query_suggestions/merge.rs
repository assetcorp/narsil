use std::collections::{BTreeMap, HashMap, HashSet};

use super::constants::{
    KEY_FINGERPRINT_BYTES, MERGE_ENTRY_OVERHEAD_BYTES, MERGE_SLOT_OVERHEAD_BYTES,
    SCRAMBLED_ID_BYTES,
};
use super::counts_file::{OpenedCountsFile, open_counts_file};
use super::counts_groups::VisitedPhrase;
use super::scramble::ScrambledId;
use crate::error::{ErrorCode, NarsilError, Result};

pub(crate) struct MergeSettings {
    pub(crate) min_people: usize,
    pub(crate) max_merge_phrases: usize,
    pub(crate) max_groups: usize,
    pub(crate) banned: HashSet<String>,
    pub(crate) memory_bytes: u64,
    pub(crate) fingerprint: [u8; KEY_FINGERPRINT_BYTES],
}

pub(crate) enum FileOutcome {
    Merged { day: String, saved_at: u64 },
    Damaged,
    OtherKey,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DuePhrase {
    pub(crate) phrase: String,
    pub(crate) count: u64,
}

#[derive(Debug)]
pub(crate) struct MergeResult {
    pub(crate) groups: BTreeMap<String, Vec<DuePhrase>>,
    pub(crate) discarded: u64,
}

struct Entry {
    count: u64,
    people: Option<HashSet<ScrambledId>>,
}

type EntryKey = (Box<str>, Box<str>);

pub(crate) struct Merger {
    settings: MergeSettings,
    entries: HashMap<EntryKey, Entry>,
    groups: HashSet<String>,
    text_bytes: u64,
    people_slots: u64,
    discarded: u64,
}

pub(crate) fn compare_utf16(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

impl Merger {
    pub(crate) fn new(settings: MergeSettings, marked_groups: HashSet<String>) -> Merger {
        Merger {
            groups: marked_groups,
            settings,
            entries: HashMap::new(),
            text_bytes: 0,
            people_slots: 0,
            discarded: 0,
        }
    }

    fn require_within(&self, extra: u64) -> Result<()> {
        let held = (self.entries.capacity() as u64)
            .saturating_mul(MERGE_ENTRY_OVERHEAD_BYTES)
            .saturating_add(self.text_bytes)
            .saturating_add(
                self.people_slots
                    .saturating_mul(SCRAMBLED_ID_BYTES as u64 + MERGE_SLOT_OVERHEAD_BYTES),
            );
        let limit = self.settings.memory_bytes;
        if held.saturating_add(extra) > limit {
            return Err(NarsilError::new(
                ErrorCode::WORKER_ACTION_FAILED,
                format!(
                    "The query suggestions merge failed: it needs more than the {limit} bytes that mergeMemoryBytes allows"
                ),
            ));
        }
        Ok(())
    }

    pub(crate) fn add_file(&mut self, bytes: &[u8], expected_day: &str) -> Result<FileOutcome> {
        self.require_within(bytes.len() as u64)?;
        let fingerprint = self.settings.fingerprint;
        let opened = match open_counts_file(bytes, Some(expected_day), &fingerprint) {
            OpenedCountsFile::Counts(opened) => opened,
            OpenedCountsFile::Damaged(_) => return Ok(FileOutcome::Damaged),
            OpenedCountsFile::OtherKey => return Ok(FileOutcome::OtherKey),
        };
        opened.visit(&mut |visited| self.merge_phrase(visited))?;
        Ok(FileOutcome::Merged {
            day: opened.day.clone(),
            saved_at: opened.saved_at,
        })
    }

    fn merge_phrase(&mut self, visited: &VisitedPhrase<'_>) -> Result<()> {
        let (group, phrase) = (visited.group, visited.phrase);
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
        entry.count = entry.count.saturating_add(visited.count);
        let Some(set) = entry.people.as_mut() else {
            return Ok(());
        };
        let before = set.capacity() as u64;
        let reached = visited.people.iter().any(|person| {
            set.insert(*person);
            set.len() >= min_people
        });
        let after = if reached { 0 } else { set.capacity() as u64 };
        if reached {
            entry.people = None;
        }
        self.people_slots = self
            .people_slots
            .saturating_sub(before)
            .saturating_add(after);
        self.require_within(0)
    }

    pub(crate) fn result(self) -> MergeResult {
        let mut groups: BTreeMap<String, Vec<DuePhrase>> = BTreeMap::new();
        for ((group, phrase), entry) in self.entries {
            if entry.people.is_none() {
                groups.entry(group.into()).or_default().push(DuePhrase {
                    phrase: phrase.into(),
                    count: entry.count,
                });
            }
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
