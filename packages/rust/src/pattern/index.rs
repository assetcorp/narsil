use std::collections::{BTreeMap, BTreeSet};

use super::text::{Run, append_text_code_points, find_run, runs_of};
use crate::format::keyword_columns::PatternColumn;
use crate::value::Value;

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct GrowingPatternIndex {
    runs: BTreeMap<Run, Vec<u32>>,
    documents: Vec<u32>,
}

fn holds_text_value(value: &Value) -> bool {
    matches!(value, Value::String(_) | Value::Array(_))
}

fn for_each_text_value(value: &Value, mut visit: impl FnMut(&str)) {
    match value {
        Value::String(text) => visit(text),
        Value::Array(elements) => {
            for element in elements {
                if let Value::String(text) = element {
                    visit(text);
                }
            }
        }
        _ => {}
    }
}

fn run_keys_of(value: &Value) -> BTreeSet<Run> {
    let mut keys = BTreeSet::new();
    let mut folded = Vec::new();
    for_each_text_value(value, |text| {
        folded.clear();
        append_text_code_points(text, true, &mut folded);
        keys.extend(runs_of(&folded));
    });
    keys
}

fn insert_sorted(list: &mut Vec<u32>, ordinal: u32) {
    match list.last() {
        Some(&last) if last < ordinal => list.push(ordinal),
        None => list.push(ordinal),
        Some(_) => {
            if let Err(at) = list.binary_search(&ordinal) {
                list.insert(at, ordinal);
            }
        }
    }
}

impl GrowingPatternIndex {
    pub(crate) fn from_values<'a>(pairs: impl IntoIterator<Item = (u32, &'a Value)>) -> Self {
        let mut index = GrowingPatternIndex::default();
        for (ordinal, value) in pairs {
            index.add(ordinal, value);
        }
        index
    }

    pub(crate) fn add(&mut self, ordinal: u32, value: &Value) {
        if !holds_text_value(value) {
            return;
        }
        insert_sorted(&mut self.documents, ordinal);
        for key in run_keys_of(value) {
            insert_sorted(self.runs.entry(key).or_default(), ordinal);
        }
    }

    pub(crate) fn documents(&self) -> &[u32] {
        &self.documents
    }

    pub(crate) fn postings(&self, run: Run) -> &[u32] {
        self.runs.get(&run).map_or(&[], Vec::as_slice)
    }
}

fn postings_of(column: &PatternColumn, run: usize) -> &[u32] {
    let start = column.offsets.get(run).copied().unwrap_or(0) as usize;
    let end = column.offsets.get(run + 1).copied().unwrap_or(0) as usize;
    column.postings.get(start..end).unwrap_or(&[])
}

#[derive(Clone, Copy)]
pub(crate) enum PatternIndexRef<'a> {
    Column(&'a PatternColumn),
    Growing(&'a GrowingPatternIndex),
}

impl<'a> PatternIndexRef<'a> {
    pub(crate) fn documents(&self) -> &'a [u32] {
        match self {
            PatternIndexRef::Column(column) => &column.documents,
            PatternIndexRef::Growing(index) => index.documents(),
        }
    }

    pub(crate) fn postings(&self, run: Run) -> &'a [u32] {
        match self {
            PatternIndexRef::Column(column) => {
                find_run(&column.runs, run).map_or(&[], |position| postings_of(column, position))
            }
            PatternIndexRef::Growing(index) => index.postings(run),
        }
    }
}
