use std::borrow::Cow;
use std::cmp::Ordering;

use super::documents::FieldReader;
use super::params::{SortDirection, SortField, SortMode};
use crate::ordering::{SortValue, compare_sort_keys, default_sort_mode, reduced_sort_value};
use crate::value::Value;

pub(crate) struct SortPlan<'p> {
    pub(crate) fields: Vec<&'p str>,
    pub(crate) directions: Vec<SortDirection>,
    pub(crate) modes: Vec<SortMode>,
}

impl<'p> SortPlan<'p> {
    pub(crate) fn of(sort: &'p [SortField]) -> SortPlan<'p> {
        SortPlan {
            fields: sort.iter().map(|entry| entry.field.as_str()).collect(),
            directions: sort.iter().map(|entry| entry.direction).collect(),
            modes: sort
                .iter()
                .map(|entry| entry.mode.unwrap_or(default_sort_mode(entry.direction)))
                .collect(),
        }
    }

    pub(crate) fn width(&self) -> usize {
        self.fields.len()
    }

    pub(crate) fn compare(&self, left: &[SortValue<'_>], right: &[SortValue<'_>]) -> Ordering {
        compare_sort_keys(left, right, &self.directions)
    }
}

pub(crate) fn sort_value<'r>(value: Option<Cow<'r, Value>>, mode: SortMode) -> SortValue<'r> {
    match value {
        None => SortValue::Missing,
        Some(Cow::Borrowed(value)) => reduced_sort_value(Some(value), mode),
        Some(Cow::Owned(Value::Number(number))) if number.is_finite() => SortValue::Number(number),
        Some(Cow::Owned(_)) => SortValue::Missing,
    }
}

pub(crate) fn push_key<'r>(
    keys: &mut Vec<SortValue<'r>>,
    readers: &'r [FieldReader],
    modes: &[SortMode],
    ordinal: u32,
) {
    for (reader, mode) in readers.iter().zip(modes) {
        keys.push(sort_value(reader.get(ordinal), *mode));
    }
}
