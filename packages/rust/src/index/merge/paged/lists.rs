use std::cmp::Reverse;
use std::collections::{BinaryHeap, btree_map};

use super::super::inputs::{MergeInput, as_u32, damaged};
use crate::error::Result;
use crate::format::paged_segment::removal_sort::RemovalWriter;
use crate::format::paged_segment::sink::SectionSink;
use crate::format::paged_segment::write_lists::{Row, block_summaries};
use crate::format::paged_segment::{SMALLEST_BLOCK_POSTINGS, TokenSections};
use crate::index::frozen::FrozenSegment;
use crate::index::segment::SegmentData;
use crate::index::tail::{TailSegment, TailTerm};

/// The scratch files that the token walk of a paged merge writes its postings, totals, and positions to.
pub(super) struct ListSinks {
    pub(super) postings: SectionSink,
    pub(super) token_totals: SectionSink,
    pub(super) positions: Option<(SectionSink, SectionSink)>,
}

/// The token table and token sections that the walk builds, which a reader of the merged segment holds in memory.
pub(super) struct WrittenTokens {
    pub(super) tokens: Vec<u8>,
    pub(super) token_offsets: Vec<u32>,
    pub(super) sections: TokenSections,
}

enum Cursor<'a> {
    Tail(btree_map::Iter<'a, String, TailTerm>, &'a TailSegment),
    Frozen(usize, &'a FrozenSegment),
}

enum Term<'a> {
    Tail(&'a TailTerm, &'a TailSegment),
    Frozen(usize, &'a FrozenSegment),
}

impl<'a> Cursor<'a> {
    fn next(&mut self) -> Option<(&'a str, Term<'a>)> {
        match self {
            Cursor::Tail(terms, tail) => terms
                .next()
                .map(|(token, term)| (token.as_str(), Term::Tail(term, tail))),
            Cursor::Frozen(at, segment) => {
                let token = *at;
                if token >= segment.token_count() {
                    return None;
                }
                *at += 1;
                Some((segment.token(token), Term::Frozen(token, segment)))
            }
        }
    }
}

/// Reports whether any input of a merge stores the positions of its postings.
pub(super) fn tracks_positions(inputs: &[MergeInput<'_>]) -> bool {
    inputs.iter().any(|input| match &input.entry.data {
        SegmentData::Tail(tail) => tail.track_positions && !tail.terms.is_empty(),
        SegmentData::Frozen(segment) => segment.tracks_positions(),
    })
}

/// Returns the number of postings that the inputs hold, kept or not, which bounds the removal entries of the
/// merged segment.
pub(super) fn posting_upper_bound(inputs: &[MergeInput<'_>]) -> u64 {
    inputs
        .iter()
        .map(|input| match &input.entry.data {
            SegmentData::Tail(tail) => tail
                .terms
                .values()
                .map(|term| term.postings.len() as u64)
                .sum(),
            SegmentData::Frozen(segment) => segment
                .payload
                .posting_offsets
                .last()
                .map_or(0, |&last| u64::from(last)),
        })
        .fold(0, u64::saturating_add)
}

#[derive(Default)]
struct TokenRows {
    rows: Vec<Row>,
    starts: Vec<u32>,
    positions: Vec<u32>,
}

impl TokenRows {
    fn clear(&mut self) {
        self.rows.clear();
        self.positions.clear();
        self.starts.clear();
        self.starts.push(0);
    }

    fn push(
        &mut self,
        input: &MergeInput<'_>,
        posting: (u32, u16, u16),
        positions: &[u32],
    ) -> Result<()> {
        let (ordinal, frequency, field) = posting;
        let Some(document) = input.target(ordinal) else {
            return Ok(());
        };
        self.rows.push(Row {
            document,
            frequency,
            field: input.field(field)?,
            posting: self.rows.len(),
        });
        self.positions.extend_from_slice(positions);
        self.starts
            .push(as_u32(self.positions.len(), "positions of one token")?);
        Ok(())
    }

    fn positions_of(&self, posting: usize) -> &[u32] {
        let start = self.starts.get(posting).copied().unwrap_or(0) as usize;
        let end = self.starts.get(posting + 1).copied().unwrap_or(0) as usize;
        self.positions.get(start..end).unwrap_or(&[])
    }

    fn append(&mut self, input: &MergeInput<'_>, term: &Term<'_>) -> Result<()> {
        match term {
            Term::Tail(term, tail) => {
                for (at, posting) in term.postings.iter().enumerate() {
                    let positions = match tail.track_positions {
                        true => term.positions.get(at).map_or(&[][..], Vec::as_slice),
                        false => &[],
                    };
                    let row = (posting.document, posting.frequency, posting.field);
                    self.push(input, row, positions)?;
                }
            }
            Term::Frozen(token, segment) => match segment.paged_list(*token)? {
                Some(list) => {
                    let positions = match segment.tracks_positions() {
                        true => segment.paged_positions(*token)?,
                        false => None,
                    };
                    let rows = list
                        .documents
                        .iter()
                        .zip(&list.frequencies)
                        .zip(&list.fields);
                    for (row, ((&document, &frequency), &field)) in rows.enumerate() {
                        let held = positions.as_ref().map_or(&[][..], |held| held.of(row));
                        self.push(input, (document, frequency, field), held)?;
                    }
                }
                None => {
                    let payload = &segment.payload;
                    for posting in segment.postings(*token) {
                        let (Some(&document), Some(&frequency), Some(&field)) = (
                            payload.posting_documents.get(posting),
                            payload.posting_frequencies.get(posting),
                            payload.posting_fields.get(posting),
                        ) else {
                            return Err(damaged("holds a posting outside its posting lists"));
                        };
                        let row = (document, frequency, field);
                        self.push(input, row, segment.positions(posting))?;
                    }
                }
            },
        }
        Ok(())
    }

    fn sort(&mut self) {
        let ordered = self
            .rows
            .windows(2)
            .all(|pair| (pair[0].document, pair[0].field) < (pair[1].document, pair[1].field));
        if !ordered {
            self.rows.sort_by_key(|row| (row.document, row.field));
        }
    }
}

struct Walk<'s, 'c> {
    sinks: &'s mut ListSinks,
    removals: &'s mut RemovalWriter,
    columns: &'c [Option<&'c [u32]>],
    out: WrittenTokens,
    scratch: Vec<u8>,
    postings_written: usize,
    positions_written: usize,
    blocks_written: usize,
}

impl Walk<'_, '_> {
    fn write_token(&mut self, token: &str, rows: &TokenRows) -> Result<()> {
        let number = as_u32(self.out.sections.document_frequencies.len() / 4, "tokens")?;
        self.scratch.clear();
        let mut total = 0f64;
        let mut distinct = 0u32;
        let mut occurrences = 0u32;
        let mut before: Option<u32> = None;
        for (at, row) in rows.rows.iter().enumerate() {
            self.scratch.extend_from_slice(&row.document.to_le_bytes());
            total += f64::from(row.frequency);
            if before != Some(row.document) {
                distinct += 1;
                occurrences = 0;
            }
            occurrences = occurrences.saturating_add(u32::from(row.frequency));
            before = Some(row.document);
            let after = rows.rows.get(at + 1).map(|after| after.document);
            if after != Some(row.document) {
                self.removals.add(row.document, number, occurrences)?;
            }
        }
        for row in &rows.rows {
            self.scratch.extend_from_slice(&row.frequency.to_le_bytes());
        }
        for row in &rows.rows {
            self.scratch.extend_from_slice(&row.field.to_le_bytes());
        }
        self.sinks.postings.write(&self.scratch)?;
        self.sinks.token_totals.write(&total.to_le_bytes())?;
        if let Some((offsets, values)) = self.sinks.positions.as_mut() {
            for row in &rows.rows {
                offsets.write_u32(as_u32(self.positions_written, "positions")?)?;
                self.scratch.clear();
                for &position in rows.positions_of(row.posting) {
                    self.scratch.extend_from_slice(&position.to_le_bytes());
                }
                values.write(&self.scratch)?;
                self.positions_written += rows.positions_of(row.posting).len();
            }
        }
        let sections = &mut self.out.sections;
        if rows.rows.len() > SMALLEST_BLOCK_POSTINGS {
            sections
                .block_lists
                .extend_from_slice(&number.to_le_bytes());
            self.blocks_written +=
                block_summaries(&rows.rows, self.columns, &mut sections.block_summaries)?;
            let blocks = as_u32(self.blocks_written, "blocks")?;
            sections
                .block_list_offsets
                .extend_from_slice(&blocks.to_le_bytes());
        }
        self.postings_written += rows.rows.len();
        let postings = as_u32(self.postings_written, "postings")?;
        sections
            .posting_offsets
            .extend_from_slice(&postings.to_le_bytes());
        sections
            .document_frequencies
            .extend_from_slice(&distinct.to_le_bytes());
        self.out.tokens.extend_from_slice(token.as_bytes());
        self.out
            .token_offsets
            .push(as_u32(self.out.tokens.len(), "token bytes")?);
        Ok(())
    }
}

/// Walks the tokens of every input together in code point order, as the reference merge does, and writes each
/// token's kept postings ascending by document and then field, with its total, positions, block summaries, and
/// what each document contributes to its removal entry. `columns` gives the merged field length column of each
/// merged field index.
pub(super) fn write_merged_lists(
    inputs: &[MergeInput<'_>],
    columns: &[Option<&[u32]>],
    sinks: &mut ListSinks,
    removals: &mut RemovalWriter,
) -> Result<WrittenTokens> {
    let zero = 0u32.to_le_bytes().to_vec();
    let mut walk = Walk {
        sinks,
        removals,
        columns,
        out: WrittenTokens {
            tokens: Vec::new(),
            token_offsets: vec![0],
            sections: TokenSections {
                document_frequencies: Vec::new(),
                posting_offsets: zero.clone(),
                block_lists: Vec::new(),
                block_list_offsets: zero,
                block_summaries: Vec::new(),
            },
        },
        scratch: Vec::new(),
        postings_written: 0,
        positions_written: 0,
        blocks_written: 0,
    };
    let mut cursors: Vec<Cursor<'_>> = inputs
        .iter()
        .map(|input| match &input.entry.data {
            SegmentData::Tail(tail) => Cursor::Tail(tail.terms.iter(), tail),
            SegmentData::Frozen(segment) => Cursor::Frozen(0, segment),
        })
        .collect();
    let mut heads: Vec<Option<Term<'_>>> = Vec::with_capacity(cursors.len());
    let mut heap = BinaryHeap::new();
    for (at, cursor) in cursors.iter_mut().enumerate() {
        let head = cursor.next();
        if let Some((token, _)) = &head {
            heap.push(Reverse((*token, at)));
        }
        heads.push(head.map(|(_, term)| term));
    }
    let mut rows = TokenRows::default();
    while let Some(Reverse((token, _))) = heap.peek().copied() {
        rows.clear();
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
                rows.append(input, &term)?;
            }
            if let Some((next, term)) = cursor.next() {
                if next <= token {
                    return Err(damaged("lists its tokens out of order"));
                }
                heap.push(Reverse((next, at)));
                *slot = Some(term);
            }
        }
        if rows.rows.is_empty() {
            continue;
        }
        rows.sort();
        walk.write_token(token, &rows)?;
    }
    if let Some((offsets, _)) = walk.sinks.positions.as_mut() {
        offsets.write_u32(as_u32(walk.positions_written, "positions")?)?;
    }
    Ok(walk.out)
}
