use std::sync::Arc;

use super::automaton::PatternProgram;
use super::constants::{DEFAULT_MATCHER_STATE_BYTES, PATTERN_RUN_CODE_POINTS};
use super::dfa::LazyDfa;
use super::fold::fold;
use super::index::PatternIndexRef;
use super::literal::LiteralMatcher;
use super::meter::{WorkMeter, WorkTally};
use super::prepared::{PreparedMatch, PreparedPattern, TypoTest};
use super::shortlist::{LiveIndex, run_lists, shortlist};
use super::typo_text::BandedRows;
use crate::error::Result;

pub(crate) trait TextValues {
    fn for_each_text(
        &self,
        ordinal: u32,
        visit: &mut dyn FnMut(&str) -> Result<bool>,
    ) -> Result<()>;
}

pub(crate) struct PatternScratch {
    dfa: Option<LazyDfa>,
    state_bytes: usize,
    rows: BandedRows,
    compared: Vec<u32>,
}

impl Default for PatternScratch {
    fn default() -> PatternScratch {
        PatternScratch::new(DEFAULT_MATCHER_STATE_BYTES)
    }
}

impl PatternScratch {
    pub(crate) fn new(state_bytes: usize) -> PatternScratch {
        PatternScratch {
            dfa: None,
            state_bytes,
            rows: BandedRows::new(),
            compared: Vec::new(),
        }
    }

    fn dfa_for(&mut self, program: &Arc<PatternProgram>) -> &mut LazyDfa {
        let reusable = self
            .dfa
            .as_ref()
            .is_some_and(|dfa| Arc::ptr_eq(dfa.program(), program));
        if !reusable {
            self.dfa = None;
        }
        let state_bytes = self.state_bytes;
        self.dfa
            .get_or_insert_with(|| LazyDfa::new(Arc::clone(program), state_bytes))
    }
}

#[inline]
fn set_bit(words: &mut [u32], ordinal: u32) {
    if let Some(word) = words.get_mut((ordinal >> 5) as usize) {
        *word |= 1 << (ordinal & 31);
    }
}

#[inline]
fn is_set(words: &[u32], ordinal: u32) -> bool {
    words
        .get((ordinal >> 5) as usize)
        .is_some_and(|word| word & (1 << (ordinal & 31)) != 0)
}

#[inline]
fn skipped(words: &[u32], ordinal: u32) -> bool {
    words
        .get((ordinal >> 5) as usize)
        .is_none_or(|word| word & (1 << (ordinal & 31)) != 0)
}

enum Matcher<'a> {
    Literal(LiteralMatcher),
    Expression(&'a mut LazyDfa),
}

impl Matcher<'_> {
    fn begin(&mut self) -> bool {
        match self {
            Matcher::Literal(matcher) => matcher.begin(),
            Matcher::Expression(dfa) => dfa.begin(),
        }
    }

    #[inline]
    fn feed(&mut self, code_point: u32, tally: &mut WorkTally<'_>) -> Result<bool> {
        match self {
            Matcher::Literal(matcher) => matcher.feed(code_point, tally),
            Matcher::Expression(dfa) => dfa.feed(code_point, tally),
        }
    }

    fn matched(&mut self) -> bool {
        match self {
            Matcher::Literal(matcher) => matcher.matched(),
            Matcher::Expression(dfa) => dfa.matched(),
        }
    }

    fn matches_text(
        &mut self,
        text: &str,
        case_fold: bool,
        tally: &mut WorkTally<'_>,
    ) -> Result<bool> {
        if !self.begin() {
            return Ok(self.matched());
        }
        for character in text.chars() {
            let code_point = character as u32;
            if !case_fold {
                if !self.feed(code_point, tally)? {
                    return Ok(self.matched());
                }
                continue;
            }
            for &folded in fold(code_point).as_slice() {
                if !self.feed(folded, tally)? {
                    return Ok(self.matched());
                }
            }
        }
        Ok(self.matched())
    }
}

fn compared_form(test: &TypoTest, value: &str, compared: &mut Vec<u32>) -> bool {
    compared.clear();
    let mut counted: i64 = 0;
    for character in value.chars() {
        if counted > test.longest {
            break;
        }
        if test.case_fold {
            compared.extend_from_slice(fold(character as u32).as_slice());
        } else {
            compared.push(character as u32);
        }
        counted = compared.len() as i64;
    }
    counted <= test.longest && counted >= test.shortest
}

fn match_within_tolerance(
    test: &TypoTest,
    index: LiveIndex<'_>,
    values: &dyn TextValues,
    matches: &mut [u32],
    scratch: &mut PatternScratch,
    tally: &mut WorkTally<'_>,
) -> Result<()> {
    let lists = if test.runs.len() < test.needed * PATTERN_RUN_CODE_POINTS {
        vec![index.documents()]
    } else {
        let mut lists = run_lists(index, &test.runs, tally)?;
        lists.truncate(test.needed);
        lists
    };
    let mut checked = vec![0u32; matches.len()];
    for list in lists {
        tally.add(list.len() as u64)?;
        for &ordinal in list.iter() {
            if skipped(&checked, ordinal) {
                continue;
            }
            set_bit(&mut checked, ordinal);
            if skipped(matches, ordinal) {
                continue;
            }
            let mut matched = false;
            values.for_each_text(ordinal, &mut |value| {
                if compared_form(test, value, &mut scratch.compared) {
                    let (within, cells) =
                        scratch
                            .rows
                            .within(&test.text, &scratch.compared, test.tolerance);
                    tally.add(cells)?;
                    matched = within;
                }
                Ok(!matched)
            })?;
            if matched {
                set_bit(matches, ordinal);
            }
        }
    }
    Ok(())
}

fn answered_by_typo_test(
    prepared: &PreparedPattern,
    index: LiveIndex<'_>,
    values: &dyn TextValues,
    matches: &mut [u32],
    scratch: &mut PatternScratch,
    tally: &mut WorkTally<'_>,
) -> Result<bool> {
    let Some(typo) = &prepared.typo else {
        return Ok(false);
    };
    if tally.meter().claim_typo_preparation(&typo.claim_key) {
        tally.add(typo.units)?;
    }
    let Some(test) = &typo.test else {
        return Ok(false);
    };
    match_within_tolerance(test, index, values, matches, scratch, tally)?;
    Ok(true)
}

pub(crate) struct PatternTarget<'a> {
    pub(crate) index: PatternIndexRef<'a>,
    pub(crate) live: Option<&'a [u32]>,
    pub(crate) values: &'a dyn TextValues,
}

pub(crate) fn match_pattern(
    prepared: &PreparedPattern,
    target: &PatternTarget<'_>,
    matches: &mut [u32],
    meter: &WorkMeter,
    scratch: &mut PatternScratch,
) -> Result<()> {
    let index = LiveIndex {
        index: target.index,
        live: target.live,
    };
    let values = target.values;
    let mut tally = WorkTally::new(meter);
    if answered_by_typo_test(prepared, index, values, matches, scratch, &mut tally)? {
        return tally.flush();
    }
    let runs = match &prepared.test {
        PreparedMatch::Literal(literal) => &literal.runs,
        PreparedMatch::Expression(expression) => &expression.runs,
    };
    let shortlisted = shortlist(index, runs, &mut tally)?;
    let scanning = shortlisted.is_none();
    let candidates: &[u32] = shortlisted.as_deref().unwrap_or(target.index.documents());
    let dead = |ordinal: u32| target.live.is_some_and(|live| !is_set(live, ordinal));
    let mut matcher = match &prepared.test {
        PreparedMatch::Literal(literal) => Matcher::Literal(literal.matcher.clone()),
        PreparedMatch::Expression(expression) => {
            Matcher::Expression(scratch.dfa_for(&expression.program))
        }
    };
    let case_fold = prepared.case_fold;
    for &ordinal in candidates {
        if skipped(matches, ordinal) || dead(ordinal) {
            continue;
        }
        if scanning {
            tally.add(1)?;
        }
        let mut matched = false;
        values.for_each_text(ordinal, &mut |value| {
            matched = matcher.matches_text(value, case_fold, &mut tally)?;
            Ok(!matched)
        })?;
        if matched {
            set_bit(matches, ordinal);
        }
    }
    tally.flush()
}
