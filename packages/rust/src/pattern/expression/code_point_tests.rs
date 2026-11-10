use std::collections::HashSet;

use super::ast::{ClassName, SetItem};
use crate::pattern::fold::{append_fold, single_fold_sources};

const DIGIT_RANGES: [u32; 2] = [0x30, 0x39];
const WORD_RANGES: [u32; 8] = [0x30, 0x39, 0x41, 0x5a, 0x5f, 0x5f, 0x61, 0x7a];
const SPACE_RANGES: [u32; 6] = [0x09, 0x0a, 0x0c, 0x0d, 0x20, 0x20];

fn class_ranges(name: ClassName) -> &'static [u32] {
    match name {
        ClassName::Digit => &DIGIT_RANGES,
        ClassName::Word => &WORD_RANGES,
        ClassName::Space => &SPACE_RANGES,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CodePointTest {
    pub(crate) ranges: Vec<u32>,
    pub(crate) negated: bool,
    pub(crate) folded: bool,
}

fn merged_ranges(bounds: &[u32]) -> Vec<u32> {
    let mut pairs: Vec<(u32, u32)> = bounds
        .chunks_exact(2)
        .map(|pair| (pair[0], pair[1]))
        .collect();
    pairs.sort_by_key(|pair| pair.0);
    let mut merged: Vec<u32> = Vec::with_capacity(pairs.len() * 2);
    for (low, high) in pairs {
        match merged.last_mut() {
            Some(last) if u64::from(low) <= u64::from(*last) + 1 => *last = (*last).max(high),
            _ => {
                merged.push(low);
                merged.push(high);
            }
        }
    }
    merged
}

fn in_ranges(ranges: &[u32], code_point: u32) -> bool {
    let mut low = 0;
    let mut high = ranges.len() / 2;
    while low < high {
        let middle = (low + high) / 2;
        if code_point < ranges[middle * 2] {
            high = middle;
        } else if code_point > ranges[middle * 2 + 1] {
            low = middle + 1;
        } else {
            return true;
        }
    }
    false
}

impl CodePointTest {
    pub(crate) fn checks_fold_targets(&self) -> bool {
        self.folded
    }

    pub(crate) fn has(&self, code_point: u32) -> bool {
        let inside = if self.folded {
            in_ranges(&self.ranges, code_point)
                || single_fold_sources(code_point)
                    .iter()
                    .any(|&source| in_ranges(&self.ranges, source))
        } else {
            in_ranges(&self.ranges, code_point)
        };
        inside != self.negated
    }
}

pub(crate) fn class_test(name: ClassName) -> CodePointTest {
    CodePointTest {
        ranges: merged_ranges(class_ranges(name)),
        negated: false,
        folded: false,
    }
}

fn range_bounds_of(items: &[SetItem]) -> Vec<u32> {
    let mut bounds = Vec::with_capacity(items.len() * 2);
    for item in items {
        match item {
            SetItem::Member(code_point) => bounds.extend_from_slice(&[*code_point, *code_point]),
            SetItem::Range(low, high) => bounds.extend_from_slice(&[*low, *high]),
            SetItem::Class(name) => bounds.extend_from_slice(class_ranges(*name)),
        }
    }
    bounds
}

pub(crate) fn set_test(items: &[SetItem], negated: bool, case_fold: bool) -> CodePointTest {
    CodePointTest {
        ranges: merged_ranges(&range_bounds_of(items)),
        negated,
        folded: case_fold,
    }
}

pub(crate) fn distinct_multi_folds(items: &[SetItem]) -> Vec<Vec<u32>> {
    let mut seen: HashSet<Vec<u32>> = HashSet::new();
    let mut folds = Vec::new();
    for item in items {
        let SetItem::Member(code_point) = item else {
            continue;
        };
        let mut fold = Vec::new();
        append_fold(*code_point, &mut fold);
        if fold.len() < 2 || !seen.insert(fold.clone()) {
            continue;
        }
        folds.push(fold);
    }
    folds
}
