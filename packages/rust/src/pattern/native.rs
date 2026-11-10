use std::collections::HashMap;

use super::constants::{AUTO_PATTERN_TOLERANCE, DEFAULT_MATCHER_STATE_BYTES};
use super::meter::WorkMeter;
use crate::error::Result;
use crate::ffi;
use crate::format::keyword_columns::PatternColumn;
use crate::index::merge::tail_pattern_column;
use crate::index::segment::{SegmentData, SegmentEntry};
use crate::keyword::workspace::{core_refused, with_workspace};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PatternOperator {
    Eq,
    StartsWith,
    EndsWith,
    Contains,
    Wildcard,
    Regex,
}

impl PatternOperator {
    fn native(self) -> u32 {
        match self {
            PatternOperator::Eq => ffi::NARSIL_PATTERN_EQ,
            PatternOperator::StartsWith => ffi::NARSIL_PATTERN_STARTS_WITH,
            PatternOperator::EndsWith => ffi::NARSIL_PATTERN_ENDS_WITH,
            PatternOperator::Contains => ffi::NARSIL_PATTERN_CONTAINS,
            PatternOperator::Wildcard => ffi::NARSIL_PATTERN_WILDCARD,
            PatternOperator::Regex => ffi::NARSIL_PATTERN_REGEX,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PatternTolerance {
    Fixed(u32),
    Auto,
}

impl PatternTolerance {
    fn native(self) -> u32 {
        match self {
            PatternTolerance::Fixed(count) => count,
            PatternTolerance::Auto => AUTO_PATTERN_TOLERANCE,
        }
    }

    fn as_text(self) -> String {
        match self {
            PatternTolerance::Fixed(count) => count.to_string(),
            PatternTolerance::Auto => "auto".to_string(),
        }
    }
}

pub(crate) struct PatternTest<'a> {
    pub(crate) operator: PatternOperator,
    pub(crate) text: &'a str,
    pub(crate) case_fold: bool,
    pub(crate) tolerance: PatternTolerance,
}

impl PatternTest<'_> {
    fn counts_preparation(&self, meter: &WorkMeter) -> bool {
        self.operator == PatternOperator::Eq
            && self.tolerance != PatternTolerance::Fixed(0)
            && meter.claim_typo_preparation(&format!(
                "{}|{}|{}",
                self.case_fold,
                self.tolerance.as_text(),
                self.text
            ))
    }
}

fn holds(bits: &[u32], ordinal: u32) -> bool {
    bits.get((ordinal >> 5) as usize)
        .is_some_and(|word| word & (1 << (ordinal & 31)) != 0)
}

fn without_removed(column: PatternColumn, removed: &[u32]) -> PatternColumn {
    if removed.iter().all(|word| *word == 0) {
        return column;
    }
    let kept = |ordinal: &u32| !holds(removed, *ordinal);
    let mut offsets = Vec::with_capacity(column.offsets.len());
    let mut postings = Vec::with_capacity(column.postings.len());
    offsets.push(0);
    for bounds in column.offsets.windows(2) {
        let list = column
            .postings
            .get(bounds[0] as usize..bounds[1] as usize)
            .unwrap_or(&[]);
        postings.extend(list.iter().copied().filter(kept));
        offsets.push(postings.len() as u32);
    }
    PatternColumn {
        documents: column.documents.iter().copied().filter(kept).collect(),
        field: column.field,
        runs: column.runs,
        offsets,
        postings,
    }
}

fn list(values: &[u32]) -> ffi::narsil_pattern_list {
    ffi::narsil_pattern_list {
        values: values.as_ptr(),
        count: values.len(),
    }
}

pub(crate) struct PatternIndexes<'s> {
    entry: &'s SegmentEntry,
    growing: HashMap<String, Option<PatternColumn>>,
}

impl<'s> PatternIndexes<'s> {
    pub(crate) fn new(entry: &'s SegmentEntry) -> PatternIndexes<'s> {
        PatternIndexes {
            entry,
            growing: HashMap::new(),
        }
    }

    fn column(&mut self, path: &str) -> Result<Option<&PatternColumn>> {
        let entry = self.entry;
        match &entry.data {
            SegmentData::Frozen(segment) => Ok(segment
                .payload
                .pattern
                .iter()
                .find(|column| column.field == path)),
            SegmentData::Tail(tail) => {
                if !self.growing.contains_key(path) {
                    let built = match tail.columns.patterns.get(path) {
                        Some(values) => Some(without_removed(
                            tail_pattern_column(path, values)?,
                            entry.removed_bits(),
                        )),
                        None => None,
                    };
                    self.growing.insert(path.to_string(), built);
                }
                Ok(self.growing.get(path).and_then(Option::as_ref))
            }
        }
    }

    pub(crate) fn match_into(
        &mut self,
        path: &str,
        test: &PatternTest<'_>,
        meter: &WorkMeter,
        into: &mut [u32],
    ) -> Result<()> {
        let entry = self.entry;
        let Some(column) = self.column(path)? else {
            return Ok(());
        };
        let index = ffi::narsil_pattern_index {
            documents: list(&column.documents),
            runs: list(&column.runs),
            offsets: list(&column.offsets),
            postings: list(&column.postings),
        };
        let stored = entry.core_stored_values(path)?;
        let values = stored.view();
        let units: Vec<u16> = test.text.encode_utf16().collect();
        let native = ffi::narsil_pattern_test {
            text: units.as_ptr(),
            length: units.len(),
            operator_kind: test.operator.native(),
            case_fold: u32::from(test.case_fold),
            tolerance: test.tolerance.native(),
            count_preparation: u32::from(test.counts_preparation(meter)),
            matcher_bytes: DEFAULT_MATCHER_STATE_BYTES,
        };
        let work = meter.native();
        let status = with_workspace(|workspace| {
            Ok(unsafe {
                ffi::narsil_pattern_match(
                    workspace,
                    &index,
                    &values,
                    &native,
                    &work,
                    into.as_mut_ptr(),
                    into.len(),
                )
            })
        })?;
        match status {
            ffi::NARSIL_OK => Ok(()),
            ffi::NARSIL_WORK_CAP_EXCEEDED => Err(meter.exceeded()),
            status => Err(core_refused("a pattern test", status)),
        }
    }
}
