use std::cmp::Ordering;

use super::source::{empty_bits, has_bit, set_bit};
use crate::engine::query::documents::FieldReader;
use crate::error::Result;
use crate::index::segment::SegmentEntry;
use crate::ordering::{SORT_VALUE_MAX_CODE_POINTS, compare_sort_strings};
use crate::value::Value;

pub(super) struct TextBound<'a> {
    pub(super) text: &'a str,
    pub(super) inclusive: bool,
}

enum SortScalar<'a> {
    Number(f64),
    Text(&'a str),
    Boolean(bool),
}

fn truncated(text: &str) -> &str {
    match text.char_indices().nth(SORT_VALUE_MAX_CODE_POINTS) {
        Some((at, _)) => &text[..at],
        None => text,
    }
}

fn rank(value: &SortScalar<'_>) -> u8 {
    match value {
        SortScalar::Number(_) => 0,
        SortScalar::Text(_) => 1,
        SortScalar::Boolean(_) => 2,
    }
}

fn compare(left: &SortScalar<'_>, right: &SortScalar<'_>) -> Ordering {
    match (left, right) {
        (SortScalar::Number(a), SortScalar::Number(b)) => {
            a.partial_cmp(b).unwrap_or(Ordering::Equal)
        }
        (SortScalar::Text(a), SortScalar::Text(b)) => compare_sort_strings(a, b),
        (SortScalar::Boolean(a), SortScalar::Boolean(b)) => a.cmp(b),
        _ => rank(left).cmp(&rank(right)),
    }
}

fn scalar(value: &Value) -> Option<SortScalar<'_>> {
    match value {
        Value::Bool(flag) => Some(SortScalar::Boolean(*flag)),
        Value::Number(number) if number.is_finite() => Some(SortScalar::Number(*number)),
        Value::String(text) => Some(SortScalar::Text(truncated(text))),
        _ => None,
    }
}

fn smallest(value: &Value) -> Option<SortScalar<'_>> {
    match value {
        Value::Array(items) => items
            .iter()
            .filter_map(scalar)
            .fold(None, |chosen, candidate| match chosen {
                Some(chosen) if compare(&candidate, &chosen) != Ordering::Less => Some(chosen),
                _ => Some(candidate),
            }),
        other => scalar(other),
    }
}

fn passes(value: &SortScalar<'_>, bound: Option<&TextBound<'_>>, above: bool) -> bool {
    let Some(bound) = bound else {
        return true;
    };
    match compare(value, &SortScalar::Text(truncated(bound.text))) {
        Ordering::Equal => bound.inclusive,
        Ordering::Greater => above,
        Ordering::Less => !above,
    }
}

pub(super) fn text_range_bits(
    entry: &SegmentEntry,
    path: &str,
    lower: Option<&TextBound<'_>>,
    upper: Option<&TextBound<'_>>,
    live: &[u32],
) -> Result<Vec<u32>> {
    let mut bits = empty_bits(entry.capacity());
    let reader = FieldReader::of(entry, path)?;
    for ordinal in 0..entry.capacity() {
        if !has_bit(live, ordinal) {
            continue;
        }
        let Some(value) = reader.get(ordinal) else {
            continue;
        };
        let Some(sorted) = smallest(&value) else {
            continue;
        };
        if passes(&sorted, lower, true) && passes(&sorted, upper, false) {
            set_bit(&mut bits, ordinal);
        }
    }
    Ok(bits)
}
