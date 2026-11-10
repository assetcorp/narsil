mod rows;

use std::collections::HashMap;

use super::query::PhraseRows;
use super::request::Row;
use crate::error::Result;
use crate::ffi;
use crate::index::segment::SegmentEntry;
use crate::keyword::dictionary::Dictionary;
use crate::keyword::workspace::{core_refused, with_workspace};
use crate::pattern::WorkMeter;
use rows::{TokenPostings, token_postings};

const BITS_PER_WORD: u32 = 32;

/// A quoted phrase after analysis: its tokens in position order, each with its distance from the first token.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AnalysedPhrase {
    pub(crate) key: String,
    pub(crate) tokens: Vec<String>,
    pub(crate) offsets: Vec<u32>,
}

/// Gives the meter that a phrase match counts its work into, failing the query once the work passes the cap.
pub(crate) trait PhraseWork {
    fn meter(&self) -> &WorkMeter;
}

/// The documents of one segment that hold every phrase, with each phrase's rows for scoring.
pub(crate) struct PhraseMatches {
    pub(crate) matched: Vec<u32>,
    pub(crate) rows: Vec<PhraseRows>,
}

fn bitmap_words(capacity: u32) -> usize {
    (capacity.div_ceil(BITS_PER_WORD) as usize).max(1)
}

fn sized_bits(bits: &[u32], words: usize) -> Vec<u32> {
    let mut sized = vec![0u32; words];
    for (target, &word) in sized.iter_mut().zip(bits) {
        *target = word;
    }
    sized
}

struct PhraseEntries<'a> {
    postings: Vec<TokenPostings<'a>>,
    starts: Vec<u32>,
    tokens: Vec<u32>,
    offsets: Vec<u32>,
}

fn phrase_entries<'a>(
    entry: &'a SegmentEntry,
    phrases: &[AnalysedPhrase],
) -> Result<PhraseEntries<'a>> {
    let dictionary = Dictionary::of(entry);
    let mut entries = PhraseEntries {
        postings: Vec::new(),
        starts: Vec::with_capacity(phrases.len() + 1),
        tokens: Vec::new(),
        offsets: Vec::new(),
    };
    let mut seen: HashMap<&str, u32> = HashMap::new();
    for phrase in phrases {
        entries.starts.push(entries.tokens.len() as u32);
        for (token, &offset) in phrase.tokens.iter().zip(&phrase.offsets) {
            let at = match seen.get(token.as_str()) {
                Some(&at) => at,
                None => {
                    let at = entries.postings.len() as u32;
                    entries
                        .postings
                        .push(token_postings(entry, &dictionary, token)?);
                    seen.insert(token, at);
                    at
                }
            };
            entries.tokens.push(at);
            entries.offsets.push(offset);
        }
    }
    entries.starts.push(entries.tokens.len() as u32);
    Ok(entries)
}

fn row_capacity(entries: &PhraseEntries<'_>) -> usize {
    entries
        .starts
        .windows(2)
        .map(|pair| {
            entries.tokens[pair[0] as usize..pair[1] as usize]
                .iter()
                .map(|&at| entries.postings[at as usize].count())
                .min()
                .unwrap_or(0)
        })
        .sum()
}

/// Finds the documents of one segment that hold every phrase in a searchable field, where `filter` allows them,
/// through the native core, which counts the work of the match into the query's meter.
pub(crate) fn match_phrases(
    entry: &SegmentEntry,
    phrases: &[AnalysedPhrase],
    searchable: &[u8],
    filter: Option<&[u32]>,
    work: &mut dyn PhraseWork,
) -> Result<PhraseMatches> {
    let entries = phrase_entries(entry, phrases)?;
    let capacity = entry.capacity();
    let words = bitmap_words(capacity);
    let removed = sized_bits(entry.removed_bits(), words);
    let filter = filter.map(|bits| sized_bits(bits, words));
    let raw_postings: Vec<ffi::narsil_phrase_postings> =
        entries.postings.iter().map(TokenPostings::raw).collect();
    let meter = work.meter();
    let request = ffi::narsil_phrase_request {
        postings: raw_postings.as_ptr(),
        token_count: raw_postings.len(),
        starts: entries.starts.as_ptr(),
        phrase_count: phrases.len(),
        tokens: entries.tokens.as_ptr(),
        offsets: entries.offsets.as_ptr(),
        entry_count: entries.tokens.len(),
        searchable: searchable.as_ptr(),
        field_count: searchable.len() as u32,
        filter: filter
            .as_ref()
            .map_or(std::ptr::null(), |bits| bits.as_ptr()),
        filter_words: filter.as_ref().map_or(0, Vec::len),
        removed: removed.as_ptr(),
        removed_words: removed.len(),
        ordinal_count: capacity,
        collect: 1,
        meter: meter.native(),
    };
    let rows = row_capacity(&entries);
    let mut matched = vec![0u32; words];
    let mut starts = vec![0u32; phrases.len() + 1];
    let mut documents = vec![0u32; rows];
    let mut fields = vec![0u16; rows];
    let mut frequencies = vec![0u32; rows];
    let output = ffi::narsil_phrase_output {
        matched: matched.as_mut_ptr(),
        matched_words: matched.len(),
        starts: starts.as_mut_ptr(),
        start_capacity: starts.len(),
        documents: documents.as_mut_ptr(),
        fields: fields.as_mut_ptr(),
        frequencies: frequencies.as_mut_ptr(),
        document_capacity: rows,
        field_capacity: rows,
        frequency_capacity: rows,
    };
    let mut row_count = 0u32;
    let status = with_workspace(|workspace| {
        Ok(unsafe { ffi::narsil_match_phrases(workspace, &request, &output, &mut row_count) })
    })?;
    match status {
        ffi::NARSIL_OK => {}
        ffi::NARSIL_WORK_CAP_EXCEEDED => return Err(meter.exceeded()),
        status => return Err(core_refused("a phrase match", status)),
    }
    let collected = phrases
        .iter()
        .enumerate()
        .map(|(at, phrase)| PhraseRows {
            key: phrase.key.clone(),
            tokens: phrase.tokens.clone(),
            rows: (starts[at] as usize..starts[at + 1] as usize)
                .map(|row| Row {
                    document: documents[row],
                    field: fields[row],
                    frequency: f64::from(frequencies[row]),
                })
                .collect(),
        })
        .collect();
    Ok(PhraseMatches {
        matched,
        rows: collected,
    })
}
