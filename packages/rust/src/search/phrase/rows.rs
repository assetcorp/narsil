use std::borrow::Cow;
use std::sync::Arc;

use super::PhraseWork;
use crate::error::Result;
use crate::index::frozen::FrozenSegment;
use crate::index::paged::{PostingList, PostingPositions};
use crate::index::segment::{SegmentData, SegmentEntry};
use crate::index::tail::TailTerm;

/// Where the postings and positions of one phrase token of one segment are.
pub(super) enum Source<'a> {
    Frozen {
        segment: &'a FrozenSegment,
        start: usize,
    },
    Tail(&'a TailTerm),
    Paged {
        list: Arc<PostingList>,
        positions: Arc<PostingPositions>,
    },
}

impl Source<'_> {
    pub(super) fn document(&self, row: usize) -> u32 {
        match self {
            Source::Paged { list, .. } => list.documents.get(row).copied().unwrap_or(u32::MAX),
            Source::Frozen { segment, start } => segment
                .payload
                .posting_documents
                .get(start + row)
                .copied()
                .unwrap_or(u32::MAX),
            Source::Tail(term) => term
                .postings
                .get(row)
                .map_or(u32::MAX, |posting| posting.document),
        }
    }

    pub(super) fn field(&self, row: usize) -> u16 {
        match self {
            Source::Paged { list, .. } => list.fields.get(row).copied().unwrap_or(u16::MAX),
            Source::Frozen { segment, start } => segment
                .payload
                .posting_fields
                .get(start + row)
                .copied()
                .unwrap_or(u16::MAX),
            Source::Tail(term) => term
                .postings
                .get(row)
                .map_or(u16::MAX, |posting| posting.field),
        }
    }

    pub(super) fn positions(&self, row: usize) -> &[u32] {
        match self {
            Source::Frozen { segment, start } => segment.positions(start + row),
            Source::Tail(term) => term.positions.get(row).map_or(&[], Vec::as_slice),
            Source::Paged { positions, .. } => positions.of(row),
        }
    }
}

/// The postings of one phrase token of one segment, with their documents in ascending order for lookups.
pub(super) struct TokenRows<'a> {
    pub(super) source: Source<'a>,
    keys: Cow<'a, [u32]>,
    order: Option<Vec<u32>>,
    pub(super) cursor: usize,
    pub(super) position_row: usize,
}

impl TokenRows<'_> {
    pub(super) fn count(&self) -> usize {
        self.keys.len()
    }

    fn row_at(&self, at: usize) -> usize {
        self.order
            .as_ref()
            .map_or(at, |order| order.get(at).copied().unwrap_or(0) as usize)
    }

    fn first_row_for(&mut self, document: u32) -> usize {
        let keys = &self.keys;
        let count = keys.len();
        let mut low = if self.cursor < count && keys[self.cursor] <= document {
            self.cursor
        } else {
            0
        };
        let mut high = low;
        let mut step = 1usize;
        while high < count && keys[high] < document {
            low = high + 1;
            high = high.saturating_add(step);
            step = step.saturating_mul(2);
        }
        high = high.min(count);
        while low < high {
            let middle = low + (high - low) / 2;
            if keys[middle] < document {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        self.cursor = low;
        low
    }

    pub(super) fn position_row_for(&mut self, document: u32, field: u16) -> Option<usize> {
        let mut at = self.first_row_for(document);
        while at < self.count() && self.keys[at] == document {
            let row = self.row_at(at);
            if self.source.field(row) == field {
                return Some(row);
            }
            at += 1;
        }
        None
    }
}

type FoundRows<'a> = (Source<'a>, bool, Cow<'a, [u32]>);

fn frozen_source<'a>(segment: &'a FrozenSegment, at: usize) -> Result<Option<FoundRows<'a>>> {
    if segment.paged.is_some() {
        let (Some(list), Some(positions)) = (segment.paged_list(at)?, segment.paged_positions(at)?)
        else {
            return Ok(None);
        };
        let documents = list.documents.clone();
        return Ok(Some((
            Source::Paged { list, positions },
            true,
            Cow::Owned(documents),
        )));
    }
    let range = segment.postings(at);
    let documents = segment
        .payload
        .posting_documents
        .get(range.clone())
        .unwrap_or(&[]);
    let source = Source::Frozen {
        segment,
        start: range.start,
    };
    Ok(Some((
        source,
        segment.postings_ordered(at),
        Cow::Borrowed(documents),
    )))
}

/// Returns the postings of `token` in the segment with their positions, or `None` where the segment holds no
/// positions for it.
pub(super) fn token_rows<'a>(
    entry: &'a SegmentEntry,
    token: &str,
    work: &mut dyn PhraseWork,
) -> Result<Option<TokenRows<'a>>> {
    let (source, ordered, keys): FoundRows<'a> = match &entry.data {
        SegmentData::Frozen(segment) => {
            let Some(at) = segment.term_index(token) else {
                return Ok(None);
            };
            if !segment.tracks_positions() {
                return Ok(None);
            }
            let Some(found) = frozen_source(segment, at)? else {
                return Ok(None);
            };
            found
        }
        SegmentData::Tail(tail) => {
            let Some(term) = tail.terms.get(token) else {
                return Ok(None);
            };
            if !tail.track_positions {
                return Ok(None);
            }
            let documents: Vec<u32> = term
                .postings
                .iter()
                .map(|posting| posting.document)
                .collect();
            let ordered = documents.windows(2).all(|pair| pair[0] <= pair[1]);
            (Source::Tail(term), ordered, Cow::Owned(documents))
        }
    };
    if ordered {
        return Ok(Some(TokenRows {
            source,
            keys,
            order: None,
            cursor: 0,
            position_row: 0,
        }));
    }
    work.add(keys.len() as u64)?;
    let mut order: Vec<u32> = (0..keys.len() as u32).collect();
    order.sort_by_key(|&row| keys[row as usize]);
    let sorted: Vec<u32> = order.iter().map(|&row| keys[row as usize]).collect();
    Ok(Some(TokenRows {
        source,
        keys: Cow::Owned(sorted),
        order: Some(order),
        cursor: 0,
        position_row: 0,
    }))
}
