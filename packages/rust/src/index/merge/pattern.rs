use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet, BinaryHeap};

use super::inputs::{MergeInput, as_u32};
use crate::error::Result;
use crate::format::keyword_columns::PatternColumn;
use crate::index::constants::PATTERN_RUN_CODE_POINTS;
use crate::util::case_fold::append_folded;
use crate::value::Value;

type Run = [u32; PATTERN_RUN_CODE_POINTS];

fn visit_text(value: &Value, visit: &mut dyn FnMut(&str)) {
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

fn holds_text(value: &Value) -> bool {
    matches!(value, Value::String(_) | Value::Array(_))
}

fn runs_of(value: &Value, folded: &mut Vec<u32>, out: &mut BTreeSet<Run>) {
    visit_text(value, &mut |text| {
        folded.clear();
        for point in text.chars() {
            append_folded(u32::from(point), folded);
        }
        for window in folded.windows(PATTERN_RUN_CODE_POINTS) {
            if let [first, second, third] = *window {
                out.insert([first, second, third]);
            }
        }
    });
}

fn run_at(column: &PatternColumn, run: usize) -> Option<Run> {
    let start = run.checked_mul(PATTERN_RUN_CODE_POINTS)?;
    match column.runs.get(start..start + PATTERN_RUN_CODE_POINTS)? {
        &[first, second, third] => Some([first, second, third]),
        _ => None,
    }
}

fn run_count(column: &PatternColumn) -> usize {
    column.offsets.len().saturating_sub(1)
}

fn remap_ascending(source: &[u32], input: &MergeInput<'_>, out: &mut Vec<u32>) {
    let start = out.len();
    out.extend(source.iter().filter_map(|&ordinal| input.target(ordinal)));
    if let Some(added) = out.get_mut(start..) {
        if added.windows(2).any(|pair| pair[0] > pair[1]) {
            added.sort_unstable();
        }
    }
}

/// Builds the pattern column of one field from the values that a tail's documents hold in it: every document whose
/// value is a string or a list, and every run of three case-folded code points with the documents that hold it, as
/// the reference pattern index writes them.
pub(crate) fn tail_pattern_column(path: &str, values: &[(u32, Value)]) -> Result<PatternColumn> {
    let mut documents: Vec<u32> = Vec::new();
    let mut postings_by_run: BTreeMap<Run, Vec<u32>> = BTreeMap::new();
    let mut folded = Vec::new();
    let mut runs = BTreeSet::new();
    for (ordinal, value) in values {
        if !holds_text(value) {
            continue;
        }
        documents.push(*ordinal);
        runs.clear();
        runs_of(value, &mut folded, &mut runs);
        for run in &runs {
            postings_by_run.entry(*run).or_default().push(*ordinal);
        }
    }
    documents.sort_unstable();
    documents.dedup();
    let mut column = PatternColumn {
        field: path.to_string(),
        documents,
        runs: Vec::with_capacity(postings_by_run.len() * PATTERN_RUN_CODE_POINTS),
        offsets: Vec::with_capacity(postings_by_run.len() + 1),
        postings: Vec::new(),
    };
    column.offsets.push(0);
    for (run, mut ordinals) in postings_by_run {
        ordinals.sort_unstable();
        ordinals.dedup();
        column.runs.extend_from_slice(&run);
        column.postings.extend_from_slice(&ordinals);
        column
            .offsets
            .push(as_u32(column.postings.len(), "pattern postings")?);
    }
    Ok(column)
}

/// Joins the pattern columns of one field across the inputs, keeping each input's documents through its remap,
/// walking the runs of every input together in code point order, and dropping a run that no kept document holds,
/// as the reference pattern merge does.
pub(crate) fn merge_pattern_columns(
    path: &str,
    inputs: &[(&PatternColumn, &MergeInput<'_>)],
) -> Result<PatternColumn> {
    let mut documents = Vec::new();
    for (column, input) in inputs {
        remap_ascending(&column.documents, input, &mut documents);
    }
    if documents.windows(2).any(|pair| pair[0] > pair[1]) {
        documents.sort_unstable();
    }
    let mut merged = PatternColumn {
        field: path.to_string(),
        documents,
        runs: Vec::new(),
        offsets: vec![0],
        postings: Vec::new(),
    };
    let mut cursors = vec![0usize; inputs.len()];
    let mut heap: BinaryHeap<Reverse<(Run, usize)>> = BinaryHeap::new();
    for (at, (column, _)) in inputs.iter().enumerate() {
        if run_count(column) > 0 {
            if let Some(run) = run_at(column, 0) {
                heap.push(Reverse((run, at)));
            }
        }
    }
    while let Some(Reverse((run, _))) = heap.peek().copied() {
        let before = merged.postings.len();
        while let Some(Reverse((held, at))) = heap.peek().copied() {
            if held != run {
                break;
            }
            heap.pop();
            let (Some((column, input)), Some(cursor)) = (inputs.get(at), cursors.get_mut(at))
            else {
                continue;
            };
            let start = column.offsets.get(*cursor).copied().unwrap_or(0) as usize;
            let end = column.offsets.get(*cursor + 1).copied().unwrap_or(0) as usize;
            remap_ascending(
                column.postings.get(start..end).unwrap_or(&[]),
                input,
                &mut merged.postings,
            );
            *cursor += 1;
            if *cursor < run_count(column) {
                if let Some(next) = run_at(column, *cursor) {
                    heap.push(Reverse((next, at)));
                }
            }
        }
        if merged.postings.len() == before {
            continue;
        }
        if let Some(added) = merged.postings.get_mut(before..) {
            if added.windows(2).any(|pair| pair[0] > pair[1]) {
                added.sort_unstable();
            }
        }
        merged.runs.extend_from_slice(&run);
        merged
            .offsets
            .push(as_u32(merged.postings.len(), "pattern postings")?);
    }
    Ok(merged)
}
