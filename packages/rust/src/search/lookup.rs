use std::collections::HashSet;
use std::ops::Bound;

use super::fuzzy::{fuzzy_prefix, within_edits};
use crate::index::frozen::FrozenSegment;
use crate::index::segment::{SegmentData, SegmentEntry};
use crate::index::tail::{TailPosting, TailSegment};

/// Where the postings of one term of one segment are, for a search to hand them to the native core.
#[derive(Clone, Copy)]
pub(crate) enum TermList<'a> {
    Pool {
        start: usize,
        length: usize,
        ordered: bool,
    },
    Tail(&'a [TailPosting]),
    Paged {
        segment: &'a FrozenSegment,
        token: usize,
    },
}

/// One term of a segment that a query term reaches, with its postings.
pub(crate) struct TermMatch<'a> {
    pub(crate) token: &'a str,
    pub(crate) list: TermList<'a>,
}

fn distinct_documents(documents: impl Iterator<Item = u32>, ordered: bool) -> u64 {
    if ordered {
        let mut count = 0u64;
        let mut previous = None;
        for document in documents {
            if previous != Some(document) {
                count += 1;
                previous = Some(document);
            }
        }
        return count;
    }
    documents.collect::<HashSet<u32>>().len() as u64
}

fn frozen_live_frequency(entry: &SegmentEntry, segment: &FrozenSegment, token: usize) -> u64 {
    let stored = u64::from(segment.stored_document_frequency(token));
    if entry.removed == 0 {
        return stored;
    }
    if segment.paged.is_some() {
        let removed = entry
            .removed_words
            .documents
            .get(segment.token(token))
            .copied()
            .unwrap_or(0);
        return stored.saturating_sub(removed);
    }
    let range = segment.postings(token);
    let Some(documents) = segment.payload.posting_documents.get(range) else {
        return 0;
    };
    let removed = distinct_documents(
        documents
            .iter()
            .copied()
            .filter(|&document| entry.is_removed(document)),
        segment.postings_ordered(token),
    );
    stored.saturating_sub(removed)
}

fn tail_live_frequency(entry: &SegmentEntry, postings: &[TailPosting], stored: u32) -> u64 {
    if entry.removed == 0 {
        return u64::from(stored);
    }
    distinct_documents(
        postings
            .iter()
            .map(|posting| posting.document)
            .filter(|&document| !entry.is_removed(document)),
        true,
    )
}

fn frozen_list(segment: &FrozenSegment, token: usize) -> TermList<'_> {
    if segment.paged.is_some() {
        return TermList::Paged { segment, token };
    }
    let range = segment.postings(token);
    TermList::Pool {
        start: range.start,
        length: range.len(),
        ordered: segment.postings_ordered(token),
    }
}

/// Returns the number of the segment's live documents that hold `token`.
pub(crate) fn live_document_frequency(entry: &SegmentEntry, token: &str) -> u64 {
    match &entry.data {
        SegmentData::Frozen(segment) => segment
            .term_index(token)
            .map_or(0, |at| frozen_live_frequency(entry, segment, at)),
        SegmentData::Tail(tail) => tail.terms.get(token).map_or(0, |term| {
            tail_live_frequency(entry, &term.postings, term.documents)
        }),
    }
}

/// Returns the postings of `token`, or `None` where no live document of the segment holds it.
pub(crate) fn lookup<'a>(entry: &'a SegmentEntry, token: &str) -> Option<TermList<'a>> {
    match &entry.data {
        SegmentData::Frozen(segment) => {
            let at = segment.term_index(token)?;
            (frozen_live_frequency(entry, segment, at) > 0).then(|| frozen_list(segment, at))
        }
        SegmentData::Tail(tail) => {
            let term = tail.terms.get(token)?;
            (tail_live_frequency(entry, &term.postings, term.documents) > 0)
                .then_some(TermList::Tail(&term.postings))
        }
    }
}

fn frozen_typo_matches<'a>(
    entry: &SegmentEntry,
    segment: &'a FrozenSegment,
    token: &str,
    tolerance: u32,
    prefix: &str,
) -> Vec<TermMatch<'a>> {
    segment
        .prefix_range(prefix)
        .filter_map(|at| {
            let candidate = segment.token(at);
            (within_edits(token, candidate, tolerance)
                && frozen_live_frequency(entry, segment, at) > 0)
                .then(|| TermMatch {
                    token: candidate,
                    list: frozen_list(segment, at),
                })
        })
        .collect()
}

fn tail_typo_matches<'a>(
    entry: &SegmentEntry,
    tail: &'a TailSegment,
    token: &str,
    tolerance: u32,
    prefix: &str,
) -> Vec<TermMatch<'a>> {
    tail.terms
        .range::<str, _>((Bound::Included(prefix), Bound::Unbounded))
        .take_while(|(candidate, _)| candidate.starts_with(prefix))
        .filter(|(candidate, term)| {
            within_edits(token, candidate, tolerance)
                && tail_live_frequency(entry, &term.postings, term.documents) > 0
        })
        .map(|(candidate, term)| TermMatch {
            token: candidate.as_str(),
            list: TermList::Tail(&term.postings),
        })
        .collect()
}

/// Returns every live term of the segment within `tolerance` edits of `token` that starts with its first
/// `prefix_length` characters, in code point order.
pub(crate) fn typo_matches<'a>(
    entry: &'a SegmentEntry,
    token: &'a str,
    tolerance: u32,
    prefix_length: u32,
) -> Vec<TermMatch<'a>> {
    if tolerance == 0 {
        return lookup(entry, token)
            .map(|list| vec![TermMatch { token, list }])
            .unwrap_or_default();
    }
    let prefix = fuzzy_prefix(token, prefix_length);
    match &entry.data {
        SegmentData::Frozen(segment) => {
            frozen_typo_matches(entry, segment, token, tolerance, prefix)
        }
        SegmentData::Tail(tail) => tail_typo_matches(entry, tail, token, tolerance, prefix),
    }
}
