use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashSet, btree_map};

use super::inputs::{MergeInput, as_u32, damaged};
use crate::error::Result;
use crate::format::keyword_segment::Positions;
use crate::index::frozen::FrozenSegment;
use crate::index::segment::SegmentData;
use crate::index::tail::{TailSegment, TailTerm};

/// The keyword index of a merged segment, with every posting list in token order.
#[derive(Default)]
pub(crate) struct MergedPostings {
    pub(crate) tokens: Vec<u8>,
    pub(crate) token_offsets: Vec<u32>,
    pub(crate) document_frequencies: Vec<u32>,
    pub(crate) posting_offsets: Vec<u32>,
    pub(crate) posting_documents: Vec<u32>,
    pub(crate) posting_frequencies: Vec<u16>,
    pub(crate) posting_fields: Vec<u16>,
    pub(crate) positions: Option<Positions>,
}

impl MergedPostings {
    /// Returns the index of `token` in the merged token order, or `None` where no kept posting holds it.
    pub(crate) fn token_index(&self, token: &str) -> Option<u32> {
        let count = self.token_offsets.len().saturating_sub(1);
        let wanted = token.as_bytes();
        let mut low = 0usize;
        let mut high = count;
        while low < high {
            let middle = low + (high - low) / 2;
            let start = self.token_offsets.get(middle).copied().unwrap_or(0) as usize;
            let end = self.token_offsets.get(middle + 1).copied().unwrap_or(0) as usize;
            let held = self.tokens.get(start..end).unwrap_or(&[]);
            match held.cmp(wanted) {
                std::cmp::Ordering::Less => low = middle + 1,
                std::cmp::Ordering::Greater => high = middle,
                std::cmp::Ordering::Equal => return u32::try_from(middle).ok(),
            }
        }
        None
    }
}

enum TokenCursor<'a> {
    Tail(btree_map::Iter<'a, String, TailTerm>, &'a TailSegment),
    Frozen(usize, &'a FrozenSegment),
}

enum TermRef<'a> {
    Tail(&'a TailTerm, &'a TailSegment),
    Frozen(usize, &'a FrozenSegment),
}

impl<'a> TokenCursor<'a> {
    fn next(&mut self) -> Option<(&'a str, TermRef<'a>)> {
        match self {
            TokenCursor::Tail(terms, tail) => terms
                .next()
                .map(|(token, term)| (token.as_str(), TermRef::Tail(term, tail))),
            TokenCursor::Frozen(at, segment) => {
                if *at >= segment.token_count() {
                    return None;
                }
                let token = *at;
                *at += 1;
                Some((segment.token(token), TermRef::Frozen(token, segment)))
            }
        }
    }
}

fn holds_positions(input: &MergeInput<'_>) -> bool {
    match &input.entry.data {
        SegmentData::Tail(tail) => tail.track_positions && !tail.terms.is_empty(),
        SegmentData::Frozen(segment) => segment.tracks_positions(),
    }
}

struct Writer {
    out: MergedPostings,
    position_offsets: Vec<u32>,
    position_values: Vec<u32>,
    tracks_positions: bool,
}

struct Posting<'a> {
    ordinal: u32,
    frequency: u16,
    field: u16,
    positions: &'a [u32],
}

impl Writer {
    fn push(&mut self, input: &MergeInput<'_>, posting: Posting<'_>) -> Result<bool> {
        let Some(target) = input.target(posting.ordinal) else {
            return Ok(false);
        };
        self.out.posting_documents.push(target);
        self.out.posting_frequencies.push(posting.frequency);
        self.out.posting_fields.push(input.field(posting.field)?);
        if self.tracks_positions {
            self.position_offsets
                .push(as_u32(self.position_values.len(), "positions")?);
            self.position_values.extend_from_slice(posting.positions);
        }
        Ok(true)
    }

    fn add_term(&mut self, input: &MergeInput<'_>, term: &TermRef<'_>) -> Result<u32> {
        let mut survivors: Vec<u32> = Vec::new();
        match term {
            TermRef::Tail(term, tail) => {
                for (at, posting) in term.postings.iter().enumerate() {
                    let positions = if tail.track_positions {
                        term.positions.get(at).map_or(&[][..], Vec::as_slice)
                    } else {
                        &[]
                    };
                    let kept = self.push(
                        input,
                        Posting {
                            ordinal: posting.document,
                            frequency: posting.frequency,
                            field: posting.field,
                            positions,
                        },
                    )?;
                    if kept {
                        survivors.push(posting.document);
                    }
                }
            }
            TermRef::Frozen(token, segment) => {
                let payload = &segment.payload;
                for posting in segment.postings(*token) {
                    let (Some(&ordinal), Some(&frequency), Some(&field)) = (
                        payload.posting_documents.get(posting),
                        payload.posting_frequencies.get(posting),
                        payload.posting_fields.get(posting),
                    ) else {
                        return Err(damaged("holds a posting outside its posting lists"));
                    };
                    let positions = segment.positions(posting);
                    if self.push(
                        input,
                        Posting {
                            ordinal,
                            frequency,
                            field,
                            positions,
                        },
                    )? {
                        survivors.push(ordinal);
                    }
                }
            }
        }
        Ok(distinct_documents(&survivors))
    }
}

fn distinct_documents(ordinals: &[u32]) -> u32 {
    if ordinals.windows(2).all(|pair| pair[0] <= pair[1]) {
        let mut count = 0u32;
        let mut previous: Option<u32> = None;
        for &ordinal in ordinals {
            if previous != Some(ordinal) {
                count += 1;
            }
            previous = Some(ordinal);
        }
        return count;
    }
    ordinals.iter().collect::<HashSet<_>>().len() as u32
}

fn cursor_of<'a>(input: &MergeInput<'a>) -> TokenCursor<'a> {
    match &input.entry.data {
        SegmentData::Tail(tail) => TokenCursor::Tail(tail.terms.iter(), tail),
        SegmentData::Frozen(segment) => TokenCursor::Frozen(0, segment),
    }
}

/// Joins the keyword indexes of the inputs, walking the tokens of every input together in code point order and
/// keeping, for each token, the postings of each input in input order, as the reference merge does.
pub(crate) fn merge_postings(inputs: &[MergeInput<'_>]) -> Result<MergedPostings> {
    let mut writer = Writer {
        out: MergedPostings::default(),
        position_offsets: Vec::new(),
        position_values: Vec::new(),
        tracks_positions: inputs.iter().any(holds_positions),
    };
    writer.out.token_offsets.push(0);
    writer.out.posting_offsets.push(0);
    let mut cursors: Vec<TokenCursor<'_>> = inputs.iter().map(cursor_of).collect();
    let mut heads: Vec<Option<TermRef<'_>>> = Vec::with_capacity(cursors.len());
    let mut heap = BinaryHeap::new();
    for (at, cursor) in cursors.iter_mut().enumerate() {
        let head = cursor.next();
        if let Some((token, _)) = &head {
            heap.push(Reverse((*token, at)));
        }
        heads.push(head.map(|(_, term)| term));
    }
    while let Some(Reverse((token, _))) = heap.peek().copied() {
        let mut documents = 0u32;
        let posting_start = writer.out.posting_documents.len();
        while let Some(Reverse((held, at))) = heap.peek().copied() {
            if held != token {
                break;
            }
            heap.pop();
            let (Some(input), Some(slot), Some(cursor)) =
                (inputs.get(at), heads.get_mut(at), cursors.get_mut(at))
            else {
                continue;
            };
            if let Some(term) = slot.take() {
                documents = documents.saturating_add(writer.add_term(input, &term)?);
            }
            if let Some((next, term)) = cursor.next() {
                heap.push(Reverse((next, at)));
                *slot = Some(term);
            }
        }
        if writer.out.posting_documents.len() == posting_start {
            continue;
        }
        writer.out.tokens.extend_from_slice(token.as_bytes());
        writer
            .out
            .token_offsets
            .push(as_u32(writer.out.tokens.len(), "token bytes")?);
        writer.out.document_frequencies.push(documents);
        writer
            .out
            .posting_offsets
            .push(as_u32(writer.out.posting_documents.len(), "postings")?);
    }
    if writer.tracks_positions {
        writer
            .position_offsets
            .push(as_u32(writer.position_values.len(), "positions")?);
        writer.out.positions = Some(Positions {
            offsets: writer.position_offsets,
            values: writer.position_values,
        });
    }
    Ok(writer.out)
}
