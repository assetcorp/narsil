use std::borrow::Cow;

use crate::error::Result;
use crate::index::frozen::FrozenSegment;
use crate::index::segment::{SegmentData, SegmentEntry};
use crate::keyword::dictionary::Dictionary;
use crate::keyword::pools::TERM_ORDERED;

#[derive(Clone, Copy)]
pub(crate) enum TermList<'a> {
    Pool {
        start: usize,
        length: usize,
        ordered: bool,
    },
    Paged {
        segment: &'a FrozenSegment,
        token: usize,
    },
}

pub(crate) struct TermMatch<'a> {
    pub(crate) token: Cow<'a, str>,
    pub(crate) list: TermList<'a>,
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn list_of(entry: &SegmentEntry, ordinal: u32) -> TermList<'_> {
    let at = ordinal as usize;
    match &entry.data {
        SegmentData::Frozen(segment) if segment.paged.is_some() => {
            TermList::Paged { segment, token: at }
        }
        SegmentData::Frozen(segment) => {
            let range = segment.postings(at);
            TermList::Pool {
                start: range.start,
                length: range.len(),
                ordered: segment.postings_ordered(at),
            }
        }
        SegmentData::Tail(tail) => {
            let columns = &tail.keyword.columns;
            TermList::Pool {
                start: columns.slice_start.get(at).copied().unwrap_or(0) as usize,
                length: columns.lengths.get(at).copied().unwrap_or(0) as usize,
                ordered: columns
                    .flags
                    .get(at)
                    .is_some_and(|flags| flags & TERM_ORDERED != 0),
            }
        }
    }
}

pub(crate) fn token_text(entry: &SegmentEntry, ordinal: u32) -> Cow<'_, str> {
    match &entry.data {
        SegmentData::Frozen(segment) => Cow::Borrowed(segment.token(ordinal as usize)),
        SegmentData::Tail(tail) => Cow::Owned(String::from_utf16_lossy(
            tail.keyword.terms.text(ordinal as usize),
        )),
    }
}

pub(crate) fn live_document_frequency(entry: &SegmentEntry, token: &str) -> Result<u64> {
    let dictionary = Dictionary::of(entry);
    let Some(ordinal) = dictionary.exact(&units(token))? else {
        return Ok(0);
    };
    Ok(u64::from(dictionary.document_frequency(ordinal)?))
}

pub(crate) fn lookup<'a>(entry: &'a SegmentEntry, token: &str) -> Result<Option<TermList<'a>>> {
    let dictionary = Dictionary::of(entry);
    let Some(ordinal) = dictionary.exact(&units(token))? else {
        return Ok(None);
    };
    if dictionary.document_frequency(ordinal)? == 0 {
        return Ok(None);
    }
    Ok(Some(list_of(entry, ordinal)))
}

pub(crate) fn typo_matches<'a>(
    entry: &'a SegmentEntry,
    token: &'a str,
    tolerance: u32,
    prefix_length: u32,
) -> Result<Vec<TermMatch<'a>>> {
    let dictionary = Dictionary::of(entry);
    let ordinals = dictionary.typo(&units(token), tolerance, prefix_length)?;
    Ok(ordinals
        .into_iter()
        .map(|ordinal| TermMatch {
            token: if tolerance == 0 {
                Cow::Borrowed(token)
            } else {
                token_text(entry, ordinal)
            },
            list: list_of(entry, ordinal),
        })
        .collect())
}
