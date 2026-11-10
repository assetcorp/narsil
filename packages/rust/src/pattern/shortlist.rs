use std::borrow::Cow;

use super::constants::{PATTERN_RUN_CODE_POINTS, SHORTLIST_INTERSECT_RATIO};
use super::expression::required_runs::RunQuery;
use super::index::PatternIndexRef;
use super::meter::WorkTally;
use super::text::{Run, run_at};
use crate::error::Result;

#[derive(Clone, Copy)]
pub(crate) struct LiveIndex<'a> {
    pub(crate) index: PatternIndexRef<'a>,
    pub(crate) live: Option<&'a [u32]>,
}

impl<'a> LiveIndex<'a> {
    fn kept(&self, list: &'a [u32]) -> Cow<'a, [u32]> {
        let Some(live) = self.live else {
            return Cow::Borrowed(list);
        };
        let is_live = |ordinal: u32| {
            live.get((ordinal >> 5) as usize)
                .is_some_and(|word| word & (1 << (ordinal & 31)) != 0)
        };
        Cow::Owned(
            list.iter()
                .copied()
                .filter(|&ordinal| is_live(ordinal))
                .collect(),
        )
    }

    pub(crate) fn postings(&self, run: Run) -> Cow<'a, [u32]> {
        self.kept(self.index.postings(run))
    }

    pub(crate) fn documents(&self) -> Cow<'a, [u32]> {
        self.kept(self.index.documents())
    }
}

fn intersect(candidates: &[u32], list: &[u32], tally: &mut WorkTally<'_>) -> Result<Vec<u32>> {
    let mut kept = Vec::with_capacity(candidates.len().min(list.len()));
    let mut read = 0;
    for &candidate in candidates {
        while read < list.len() && list[read] < candidate {
            read += 1;
        }
        if read == list.len() {
            break;
        }
        if list[read] == candidate {
            kept.push(candidate);
        }
    }
    tally.add(list.len().min(read + 1) as u64)?;
    Ok(kept)
}

pub(crate) fn run_lists<'a>(
    index: LiveIndex<'a>,
    runs: &[u32],
    tally: &mut WorkTally<'_>,
) -> Result<Vec<Cow<'a, [u32]>>> {
    let count = runs.len() / PATTERN_RUN_CODE_POINTS;
    let mut lists = Vec::with_capacity(count);
    for position in 0..count {
        tally.add(1)?;
        if let Some(run) = run_at(runs, position) {
            lists.push(index.postings(run));
        }
    }
    lists.sort_by_key(|list| list.len());
    Ok(lists)
}

fn shortlist_all<'a>(
    index: LiveIndex<'a>,
    runs: &[u32],
    tally: &mut WorkTally<'_>,
) -> Result<Cow<'a, [u32]>> {
    let mut lists = run_lists(index, runs, tally)?.into_iter();
    let Some(mut candidates) = lists.next() else {
        return Ok(Cow::Borrowed(&[]));
    };
    tally.add(candidates.len() as u64)?;
    for list in lists {
        if candidates.is_empty() || list.len() > candidates.len() * SHORTLIST_INTERSECT_RATIO {
            break;
        }
        candidates = Cow::Owned(intersect(&candidates, &list, tally)?);
    }
    Ok(candidates)
}

fn union(left: &[u32], right: &[u32]) -> Vec<u32> {
    let mut merged = Vec::with_capacity(left.len() + right.len());
    let (mut from_left, mut from_right) = (0, 0);
    while from_left < left.len() && from_right < right.len() {
        let smaller = left[from_left].min(right[from_right]);
        if left[from_left] == smaller {
            from_left += 1;
        }
        if right[from_right] == smaller {
            from_right += 1;
        }
        merged.push(smaller);
    }
    merged.extend_from_slice(&left[from_left..]);
    merged.extend_from_slice(&right[from_right..]);
    merged
}

pub(crate) fn shortlist<'a>(
    index: LiveIndex<'a>,
    query: &RunQuery,
    tally: &mut WorkTally<'_>,
) -> Result<Option<Cow<'a, [u32]>>> {
    match query {
        RunQuery::All(runs) if runs.is_empty() => Ok(None),
        RunQuery::All(runs) => shortlist_all(index, runs, tally).map(Some),
        RunQuery::Any(branches) => {
            let mut candidates: Cow<'a, [u32]> = Cow::Borrowed(&[]);
            for runs in branches {
                let branch = shortlist_all(index, runs, tally)?;
                candidates = if candidates.is_empty() {
                    branch
                } else if branch.is_empty() {
                    candidates
                } else {
                    Cow::Owned(union(&candidates, &branch))
                };
            }
            Ok(Some(candidates))
        }
    }
}
