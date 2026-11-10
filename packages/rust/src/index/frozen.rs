use std::borrow::Cow;
use std::ops::Range;
use std::sync::Arc;

use super::constants::PUBLISHED_TOTALS_LIMIT;
use super::fields::name_ranks;
use super::paged::{PagedSections, PostingList, PostingPositions};
use super::published::Published;
use super::stored_values::StoredValues;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::ffi;
use crate::format::keyword_segment::KeywordSegment;
use crate::keyword::frozen::FrozenView;
use crate::value::{Map, decode_document};

/// An immutable segment: a decoded keyword segment payload with the lookups that a search needs.
///
/// A paged segment holds only its resident sections in `payload`, and `paged` reads its postings, IDs, and
/// documents from its file one page at a time.
pub(crate) struct FrozenSegment {
    pub(crate) payload: KeywordSegment,
    pub(crate) paged: Option<PagedSections>,
    pub(crate) view: FrozenView,
    name_ranks: Vec<u16>,
    length_columns: Vec<Option<usize>>,
    ordered_postings: Vec<bool>,
    term_totals: Vec<f64>,
    paged_totals: Published<Vec<f64>>,
    pub(crate) stored_values: StoredValues,
}

fn term_totals(payload: &KeywordSegment) -> Vec<f64> {
    let offsets = &payload.posting_offsets;
    (0..payload.token_count())
        .map(|token| {
            let start = offsets.get(token).copied().unwrap_or(0) as usize;
            let end = offsets.get(token + 1).copied().unwrap_or(0) as usize;
            payload
                .posting_frequencies
                .get(start..end)
                .map_or(0.0, |frequencies| {
                    frequencies
                        .iter()
                        .map(|&frequency| f64::from(frequency))
                        .sum()
                })
        })
        .collect()
}

fn ordered_postings(payload: &KeywordSegment) -> Vec<bool> {
    let offsets = &payload.posting_offsets;
    (0..payload.token_count())
        .map(|token| {
            let start = offsets.get(token).copied().unwrap_or(0) as usize;
            let end = offsets.get(token + 1).copied().unwrap_or(0) as usize;
            payload
                .posting_documents
                .get(start..end)
                .is_none_or(|documents| documents.windows(2).all(|pair| pair[0] <= pair[1]))
        })
        .collect()
}

fn entry<'a>(blob: &'a [u8], offsets: &[u32], at: usize) -> &'a [u8] {
    let start = offsets.get(at).copied().unwrap_or(0) as usize;
    let end = offsets.get(at + 1).copied().unwrap_or(0) as usize;
    blob.get(start..end).unwrap_or(&[])
}

fn text(bytes: &[u8]) -> &str {
    std::str::from_utf8(bytes).unwrap_or("")
}

impl FrozenSegment {
    pub(crate) fn new(payload: KeywordSegment) -> FrozenSegment {
        let name_ranks = name_ranks(&payload.field_names);
        let length_columns = payload
            .field_names
            .iter()
            .map(|name| {
                payload
                    .field_lengths
                    .iter()
                    .position(|column| &column.field == name)
            })
            .collect();
        let ordered_postings = ordered_postings(&payload);
        let term_totals = term_totals(&payload);
        let view = FrozenView::new(&payload, true);
        FrozenSegment {
            payload,
            paged: None,
            view,
            name_ranks,
            length_columns,
            ordered_postings,
            term_totals,
            paged_totals: Published::default(),
            stored_values: StoredValues::default(),
        }
    }

    pub(crate) fn from_paged(resident: KeywordSegment, sections: PagedSections) -> FrozenSegment {
        let mut segment = FrozenSegment::new(resident);
        segment.ordered_postings = Vec::new();
        segment.term_totals = Vec::new();
        segment.view = FrozenView::new(&segment.payload, false);
        segment.paged = Some(sections);
        segment
    }

    pub(crate) fn occurrences(&self) -> Result<&[f64]> {
        let Some(paged) = &self.paged else {
            return Ok(&self.term_totals);
        };
        if let Some(held) = self.paged_totals.find(|_| true) {
            return Ok(held);
        }
        let mut totals = vec![0f64; self.payload.token_count()];
        paged.totals(0, &mut totals)?;
        match self
            .paged_totals
            .publish(totals, |_| true, PUBLISHED_TOTALS_LIMIT)
        {
            Ok(winner) => Ok(winner),
            Err(_) => Err(NarsilError::new(
                ErrorCode::INTERNAL_ERROR,
                "The paged term totals could not be published",
            )),
        }
    }

    /// Reports whether the postings of the token at `token` never go back to a lower document ordinal.
    pub(crate) fn postings_ordered(&self, token: usize) -> bool {
        self.paged.is_some() || self.ordered_postings.get(token).copied().unwrap_or(false)
    }

    pub(crate) fn capacity(&self) -> u32 {
        self.payload.document_count
    }

    pub(crate) fn name_ranks(&self) -> &[u16] {
        &self.name_ranks
    }

    pub(crate) fn field_names(&self) -> &[String] {
        &self.payload.field_names
    }

    pub(crate) fn id(&self, ordinal: u32) -> Result<Cow<'_, str>> {
        match &self.paged {
            Some(paged) => paged.id(ordinal).map(Cow::Owned),
            None => Ok(Cow::Borrowed(text(entry(
                &self.payload.ids,
                &self.payload.id_offsets,
                ordinal as usize,
            )))),
        }
    }

    pub(crate) fn ordinal_of(&self, id: &str) -> Result<Option<u32>> {
        if let Some(paged) = &self.paged {
            return paged.ordinal_of(id);
        }
        let order = &self.payload.id_order;
        let wanted = id.as_bytes();
        let found = order.binary_search_by(|&ordinal| {
            entry(
                &self.payload.ids,
                &self.payload.id_offsets,
                ordinal as usize,
            )
            .cmp(wanted)
        });
        Ok(found.ok().map(|at| order[at]))
    }

    /// Returns each document's ordinal and ID in ascending ID order; a paged segment, which keeps its IDs in its
    /// file, returns none.
    pub(crate) fn ids_in_order(&self) -> impl Iterator<Item = (u32, &str)> + '_ {
        self.payload.id_order.iter().map(|&ordinal| {
            let id = entry(
                &self.payload.ids,
                &self.payload.id_offsets,
                ordinal as usize,
            );
            (ordinal, text(id))
        })
    }

    pub(crate) fn document_bytes(&self, ordinal: u32) -> Result<Cow<'_, [u8]>> {
        match &self.paged {
            Some(paged) => paged.document_bytes(ordinal).map(Cow::Owned),
            None => Ok(Cow::Borrowed(entry(
                &self.payload.documents,
                &self.payload.document_offsets,
                ordinal as usize,
            ))),
        }
    }

    pub(crate) fn document(&self, ordinal: u32) -> Result<Map> {
        decode_document(&self.document_bytes(ordinal)?)
    }

    pub(crate) fn token_count(&self) -> usize {
        self.payload.token_count()
    }

    pub(crate) fn token(&self, at: usize) -> &str {
        text(entry(&self.payload.tokens, &self.payload.token_offsets, at))
    }

    pub(crate) fn postings(&self, token: usize) -> Range<usize> {
        let offsets = &self.payload.posting_offsets;
        let start = offsets.get(token).copied().unwrap_or(0) as usize;
        let end = offsets.get(token + 1).copied().unwrap_or(0) as usize;
        start..end.max(start)
    }

    /// Returns the postings of the token at `token` of a paged segment, read from its file, or `None` for a
    /// segment that holds its postings in memory.
    pub(crate) fn paged_list(&self, token: usize) -> Result<Option<Arc<PostingList>>> {
        let Some(paged) = &self.paged else {
            return Ok(None);
        };
        let range = self.postings(token);
        paged
            .list(token, range.start as u32, range.len() as u32)
            .map(Some)
    }

    pub(crate) fn with_paged_removals<T>(
        &self,
        remove: impl FnOnce(Option<&ffi::narsil_frozen_paged_removals>) -> Result<T>,
    ) -> Result<T> {
        match &self.paged {
            None => remove(None),
            Some(paged) => paged.with_removal_view(|view| remove(Some(view))),
        }
    }

    /// Returns the positions of every posting of the token at `token` of a paged segment.
    pub(crate) fn paged_positions(&self, token: usize) -> Result<Option<Arc<PostingPositions>>> {
        let Some(paged) = &self.paged else {
            return Ok(None);
        };
        let range = self.postings(token);
        paged.positions(token, range.start as u32, range.len() as u32)
    }

    pub(crate) fn field_length_column(&self, field: u16) -> &[u32] {
        match self.length_columns.get(field as usize).copied().flatten() {
            Some(column) => &self.payload.field_lengths[column].lengths,
            None => &[],
        }
    }

    pub(crate) fn tracks_positions(&self) -> bool {
        match &self.paged {
            Some(paged) => paged.tracks_positions(),
            None => self.payload.positions.is_some(),
        }
    }

    /// Returns a keyword segment that holds every section of this one, reading every page of a paged segment and
    /// checking it against every rule of the payload, as a merge needs.
    pub(crate) fn materialised(&self) -> Result<Option<FrozenSegment>> {
        let Some(paged) = &self.paged else {
            return Ok(None);
        };
        Ok(Some(FrozenSegment::new(paged.materialise(&self.payload)?)))
    }
}
