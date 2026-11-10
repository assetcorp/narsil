use std::borrow::Cow;
use std::sync::Arc;

use super::frozen::FrozenSegment;
use super::indexed::IndexedDocument;
use super::tail::TailSegment;
use crate::error::Result;
use crate::keyword::frozen_state::FrozenState;
use crate::keyword::tokens::{PackedTokens, SegmentFieldTokens};
use crate::value::Map;

#[derive(Clone)]
pub(crate) enum SegmentData {
    Frozen(Arc<FrozenSegment>),
    Tail(Arc<TailSegment>),
}

#[derive(Clone)]
pub(crate) struct SegmentEntry {
    pub(crate) id: u64,
    pub(crate) data: SegmentData,
    pub(crate) state: Option<Arc<FrozenState>>,
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

fn frozen_fields(
    segment: &FrozenSegment,
    removed: &IndexedDocument,
) -> Result<Vec<(u16, PackedTokens)>> {
    let partial = segment.view.partial_fields();
    let mut fields = Vec::new();
    for field in &removed.text {
        let Some(slot) = segment
            .field_names()
            .iter()
            .position(|name| *name == field.path)
        else {
            continue;
        };
        let tokens = if partial.get(slot).copied().unwrap_or(0) == 1 {
            field.tokens.clone()
        } else {
            field.tokens.holding_surfaces()?
        };
        fields.push((slot as u16, tokens));
    }
    fields.sort_by_key(|(slot, _)| *slot);
    Ok(fields)
}

impl SegmentEntry {
    pub(crate) fn new(id: u64, data: SegmentData) -> SegmentEntry {
        let state = match &data {
            SegmentData::Frozen(segment) => Some(Arc::new(FrozenState::new(
                &segment.view,
                segment.capacity(),
            ))),
            SegmentData::Tail(_) => None,
        };
        SegmentEntry { id, data, state }
    }

    pub(crate) fn capacity(&self) -> u32 {
        match &self.data {
            SegmentData::Frozen(segment) => segment.capacity(),
            SegmentData::Tail(tail) => tail.len() as u32,
        }
    }

    pub(crate) fn live_count(&self) -> u32 {
        match &self.data {
            SegmentData::Frozen(segment) => segment
                .capacity()
                .saturating_sub(self.state.as_ref().map_or(0, |state| state.removed())),
            SegmentData::Tail(tail) => tail.keyword.total_documents(),
        }
    }

    pub(crate) fn is_removed(&self, ordinal: u32) -> bool {
        match &self.data {
            SegmentData::Frozen(_) => self
                .state
                .as_ref()
                .is_some_and(|state| state.is_removed(ordinal)),
            SegmentData::Tail(tail) => tail.is_removed(ordinal),
        }
    }

    pub(crate) fn removed_bits(&self) -> &[u32] {
        match &self.data {
            SegmentData::Frozen(_) => self.state.as_ref().map_or(&[], |state| state.tombstones()),
            SegmentData::Tail(tail) => tail.keyword.retired(),
        }
    }

    pub(crate) fn remove(&mut self, ordinal: u32, words: &IndexedDocument) -> Result<bool> {
        if ordinal >= self.capacity() || self.is_removed(ordinal) {
            return Ok(false);
        }
        match &mut self.data {
            SegmentData::Tail(tail) => Arc::make_mut(tail).remove(ordinal, words),
            SegmentData::Frozen(segment) => {
                let owned = frozen_fields(segment, words)?;
                let fields: Vec<SegmentFieldTokens<'_>> = owned
                    .iter()
                    .map(|(slot, tokens)| SegmentFieldTokens {
                        field: *slot,
                        tokens,
                    })
                    .collect();
                let held = self.state.get_or_insert_with(|| {
                    Arc::new(FrozenState::new(&segment.view, segment.capacity()))
                });
                let state = Arc::make_mut(held);
                segment.with_paged_removals(|paged| {
                    let removed = state.remove(&segment.view, ordinal, &fields, paged)?;
                    state.settle(&segment.view, paged)?;
                    Ok(removed)
                })
            }
        }
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
                .field_names
                .iter()
                .enumerate()
                .filter_map(|(slot, name)| {
                    let length = tail.field_length(slot as u16, ordinal);
                    (length > 0).then(|| (name.clone(), length))
                })
                .collect(),
        }
    }

    pub(crate) fn live_ordinals(&self) -> impl Iterator<Item = u32> + '_ {
        (0..self.capacity()).filter(|&ordinal| !self.is_removed(ordinal))
    }
}
