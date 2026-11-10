use std::borrow::Cow;
use std::sync::Arc;

use super::frozen::FrozenSegment;
use super::indexed::IndexedDocument;
use super::spellings::StoredSpellings;
use super::tail::TailSegment;
use super::words::{RemovedWords, StoredSurfaces};
use crate::error::Result;
use crate::value::Map;

#[derive(Clone)]
pub(crate) enum SegmentData {
    Frozen(Arc<FrozenSegment>),
    Tail(Arc<TailSegment>),
}

/// One segment of a partition as a search sees it: its data and the ordinals that later writes removed from it.
#[derive(Clone)]
pub(crate) struct SegmentEntry {
    pub(crate) id: u64,
    pub(crate) data: SegmentData,
    pub(crate) tombstones: Arc<Vec<u32>>,
    pub(crate) removed: u32,
    pub(crate) removed_words: Arc<RemovedWords>,
}

pub(crate) fn bit_is_set(words: &[u32], ordinal: u32) -> bool {
    words
        .get((ordinal >> 5) as usize)
        .is_some_and(|word| word & (1 << (ordinal & 31)) != 0)
}

pub(crate) fn set_bit(words: &mut Vec<u32>, ordinal: u32) {
    let word = (ordinal >> 5) as usize;
    if word >= words.len() {
        words.resize(word + 1, 0);
    }
    words[word] |= 1 << (ordinal & 31);
}

impl SegmentEntry {
    pub(crate) fn new(id: u64, data: SegmentData) -> SegmentEntry {
        SegmentEntry {
            id,
            data,
            tombstones: Arc::new(Vec::new()),
            removed: 0,
            removed_words: Arc::new(RemovedWords::default()),
        }
    }

    pub(crate) fn stored_surfaces(&self) -> &StoredSurfaces {
        match &self.data {
            SegmentData::Frozen(segment) => &segment.surfaces,
            SegmentData::Tail(tail) => &tail.surfaces,
        }
    }

    pub(crate) fn stored_spellings(&self) -> &StoredSpellings {
        match &self.data {
            SegmentData::Frozen(segment) => &segment.spellings,
            SegmentData::Tail(tail) => &tail.spellings,
        }
    }

    pub(crate) fn capacity(&self) -> u32 {
        match &self.data {
            SegmentData::Frozen(segment) => segment.capacity(),
            SegmentData::Tail(tail) => tail.len() as u32,
        }
    }

    pub(crate) fn live_count(&self) -> u32 {
        self.capacity().saturating_sub(self.removed)
    }

    pub(crate) fn is_removed(&self, ordinal: u32) -> bool {
        bit_is_set(&self.tombstones, ordinal)
    }

    /// Removes the document at `ordinal`, taking the words of `words`, its analysis, out of the segment's counts.
    ///
    /// A paged segment takes the document's terms from its removal entry instead, which it reads before it marks
    /// the document removed, so that a damaged entry leaves the segment unchanged.
    pub(crate) fn remove(&mut self, ordinal: u32, words: Option<&IndexedDocument>) -> Result<bool> {
        if ordinal >= self.capacity() || self.is_removed(ordinal) {
            return Ok(false);
        }
        let entry_terms = match &self.data {
            SegmentData::Frozen(segment) => segment.removal_entry(ordinal)?,
            SegmentData::Tail(_) => None,
        };
        set_bit(Arc::make_mut(&mut self.tombstones), ordinal);
        self.removed += 1;
        let stored = match &self.data {
            SegmentData::Frozen(segment) => &segment.surfaces,
            SegmentData::Tail(tail) => &tail.surfaces,
        };
        let removed_words = Arc::make_mut(&mut self.removed_words);
        match (entry_terms, words) {
            (Some(terms), words) => {
                removed_words.record_entry_terms(terms);
                if let Some(words) = words {
                    removed_words.record_surfaces(words, stored);
                }
            }
            (None, Some(words)) => removed_words.record(words, stored),
            (None, None) => {}
        }
        Ok(true)
    }

    pub(crate) fn ordinal_of(&self, id: &str) -> Result<Option<u32>> {
        let ordinal = match &self.data {
            SegmentData::Frozen(segment) => segment.ordinal_of(id)?,
            SegmentData::Tail(tail) => tail.ordinal_of(id),
        };
        Ok(ordinal.filter(|&ordinal| !self.is_removed(ordinal)))
    }

    pub(crate) fn id_of(&self, ordinal: u32) -> Result<Cow<'_, str>> {
        match &self.data {
            SegmentData::Frozen(segment) => segment.id(ordinal),
            SegmentData::Tail(tail) => Ok(Cow::Borrowed(
                tail.ids.get(ordinal as usize).map_or("", String::as_str),
            )),
        }
    }

    pub(crate) fn document(&self, ordinal: u32) -> Result<Arc<Map>> {
        match &self.data {
            SegmentData::Frozen(segment) => segment.document(ordinal).map(Arc::new),
            SegmentData::Tail(tail) => Ok(tail
                .documents
                .get(ordinal as usize)
                .cloned()
                .unwrap_or_default()),
        }
    }

    pub(crate) fn field_lengths_of(&self, ordinal: u32) -> Vec<(String, u32)> {
        match &self.data {
            SegmentData::Frozen(segment) => segment
                .payload
                .field_lengths
                .iter()
                .filter_map(|column| {
                    let length = column.lengths.get(ordinal as usize).copied()?;
                    Some((column.field.clone(), length))
                })
                .collect(),
            SegmentData::Tail(tail) => tail
                .words
                .get(ordinal as usize)
                .map(|words| {
                    words
                        .field_lengths
                        .iter()
                        .map(|&(field, length)| (tail.field_names[field as usize].clone(), length))
                        .collect()
                })
                .unwrap_or_default(),
        }
    }

    pub(crate) fn live_ordinals(&self) -> impl Iterator<Item = u32> + '_ {
        (0..self.capacity()).filter(|&ordinal| !self.is_removed(ordinal))
    }
}
