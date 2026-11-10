mod constants;
mod fold;
mod fold_table;
mod keys;

use std::cmp::Ordering;

pub(crate) use constants::SORT_VALUE_MAX_CODE_POINTS;
pub(crate) use fold::compare_sort_strings;
pub(crate) use keys::{KeyColumn, SortKey, compare_keys};

use crate::engine::{SortDirection, SortMode};
use crate::value::Value;

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum SortValue<'a> {
    Missing,
    Number(f64),
    Text(&'a str),
    Bool(bool),
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum OwnedSortValue {
    Missing,
    Number(f64),
    Text(String),
    Bool(bool),
}

impl OwnedSortValue {
    pub(crate) fn borrowed(&self) -> SortValue<'_> {
        match self {
            OwnedSortValue::Missing => SortValue::Missing,
            OwnedSortValue::Number(number) => SortValue::Number(*number),
            OwnedSortValue::Text(text) => SortValue::Text(text),
            OwnedSortValue::Bool(flag) => SortValue::Bool(*flag),
        }
    }

    pub(crate) fn of_cursor(value: &Value) -> OwnedSortValue {
        match value {
            Value::Number(number) => OwnedSortValue::Number(*number),
            Value::String(text) => OwnedSortValue::Text(text.clone()),
            Value::Bool(flag) => OwnedSortValue::Bool(*flag),
            _ => OwnedSortValue::Missing,
        }
    }

    pub(crate) fn cursor_value(self) -> Value {
        match self {
            OwnedSortValue::Missing => Value::Null,
            OwnedSortValue::Number(number) => Value::Number(number),
            OwnedSortValue::Text(text) => Value::String(text),
            OwnedSortValue::Bool(flag) => Value::Bool(flag),
        }
    }
}

impl SortValue<'_> {
    pub(crate) fn owned(self) -> OwnedSortValue {
        match self {
            SortValue::Missing => OwnedSortValue::Missing,
            SortValue::Number(number) => OwnedSortValue::Number(number),
            SortValue::Text(text) => OwnedSortValue::Text(text.to_string()),
            SortValue::Bool(flag) => OwnedSortValue::Bool(flag),
        }
    }
}

pub(crate) fn default_sort_mode(direction: SortDirection) -> SortMode {
    match direction {
        SortDirection::Asc => SortMode::Min,
        SortDirection::Desc => SortMode::Max,
    }
}

pub(crate) fn truncate_sort_text(text: &str) -> &str {
    match text.char_indices().nth(SORT_VALUE_MAX_CODE_POINTS) {
        Some((end, _)) => &text[..end],
        None => text,
    }
}

pub(crate) fn comparable(value: Option<&Value>) -> SortValue<'_> {
    match value {
        Some(Value::String(text)) => SortValue::Text(truncate_sort_text(text)),
        Some(Value::Number(number)) if number.is_finite() => SortValue::Number(*number),
        Some(Value::Bool(flag)) => SortValue::Bool(*flag),
        _ => SortValue::Missing,
    }
}

fn type_rank(value: SortValue<'_>) -> u8 {
    match value {
        SortValue::Number(_) => 0,
        SortValue::Text(_) => 1,
        _ => 2,
    }
}

fn compare_present(left: SortValue<'_>, right: SortValue<'_>) -> Ordering {
    match (left, right) {
        (SortValue::Number(one), SortValue::Number(other)) => {
            one.partial_cmp(&other).unwrap_or(Ordering::Equal)
        }
        (SortValue::Text(one), SortValue::Text(other)) => compare_sort_strings(one, other),
        (SortValue::Bool(one), SortValue::Bool(other)) => one.cmp(&other),
        _ => type_rank(left).cmp(&type_rank(right)),
    }
}

fn numeric_reduction(items: &[Value], mode: SortMode) -> SortValue<'static> {
    let mut numbers: Vec<f64> = items
        .iter()
        .filter_map(|item| match item {
            Value::Number(number) if number.is_finite() => Some(*number),
            _ => None,
        })
        .collect();
    if numbers.is_empty() {
        return SortValue::Missing;
    }
    if mode == SortMode::Avg {
        let mut mean = 0.0;
        for (at, number) in numbers.iter().enumerate() {
            mean += (number - mean) / (at + 1) as f64;
        }
        return SortValue::Number(mean);
    }
    numbers.sort_by(|one, other| one.partial_cmp(other).unwrap_or(Ordering::Equal));
    let middle = numbers.len() / 2;
    if numbers.len() % 2 == 1 {
        return SortValue::Number(numbers[middle]);
    }
    SortValue::Number(numbers[middle - 1] / 2.0 + numbers[middle] / 2.0)
}

pub(crate) fn reduced_sort_value(value: Option<&Value>, mode: SortMode) -> SortValue<'_> {
    let Some(Value::Array(items)) = value else {
        return comparable(value);
    };
    if matches!(mode, SortMode::Avg | SortMode::Median) {
        return numeric_reduction(items, mode);
    }
    let mut chosen = SortValue::Missing;
    for item in items {
        let candidate = comparable(Some(item));
        if candidate == SortValue::Missing {
            continue;
        }
        if chosen == SortValue::Missing {
            chosen = candidate;
            continue;
        }
        let comparison = compare_present(candidate, chosen);
        let replaces = match mode {
            SortMode::Min => comparison == Ordering::Less,
            _ => comparison == Ordering::Greater,
        };
        if replaces {
            chosen = candidate;
        }
    }
    chosen
}

pub(crate) fn compare_sort_values(
    left: SortValue<'_>,
    right: SortValue<'_>,
    direction: SortDirection,
) -> Ordering {
    match (left, right) {
        (SortValue::Missing, SortValue::Missing) => Ordering::Equal,
        (SortValue::Missing, _) => Ordering::Greater,
        (_, SortValue::Missing) => Ordering::Less,
        _ => {
            let comparison = compare_present(left, right);
            match direction {
                SortDirection::Asc => comparison,
                SortDirection::Desc => comparison.reverse(),
            }
        }
    }
}

pub(crate) fn compare_sort_keys(
    left: &[SortValue<'_>],
    right: &[SortValue<'_>],
    directions: &[SortDirection],
) -> Ordering {
    for (at, direction) in directions.iter().enumerate() {
        let one = left.get(at).copied().unwrap_or(SortValue::Missing);
        let other = right.get(at).copied().unwrap_or(SortValue::Missing);
        let comparison = compare_sort_values(one, other, *direction);
        if comparison != Ordering::Equal {
            return comparison;
        }
    }
    Ordering::Equal
}
