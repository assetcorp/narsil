use std::borrow::Cow;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::Arc;

use super::documents::{FieldReader, matched_ordinals};
use super::javascript::{javascript_to_number, write_javascript_string};
use super::params::{FacetSpec, QueryParams, SortDirection};
use super::results::FacetResult;
use super::validate::distinct_facet_fields;
use crate::engine::index::IndexState;
use crate::error::Result;
use crate::index::derived::FacetColumn;
use crate::index::segment::SegmentEntry;
use crate::schema::BaseType;
use crate::value::{Value, number_to_text};

pub(crate) struct MatchedSegment<'a> {
    pub(crate) partition: u32,
    pub(crate) segment: u32,
    pub(crate) entry: &'a SegmentEntry,
    pub(crate) words: Cow<'a, [u32]>,
}

fn value_key(value: &Value) -> String {
    if let Value::String(text) = value {
        return text.clone();
    }
    let mut key = String::new();
    write_javascript_string(&mut key, value);
    key
}

fn is_indexed(base: BaseType) -> bool {
    matches!(
        base,
        BaseType::Enum
            | BaseType::EnumList
            | BaseType::Boolean
            | BaseType::BooleanList
            | BaseType::Number
            | BaseType::NumberList
    )
}

fn indexed_key(base: BaseType, item: &Value) -> Option<Cow<'_, str>> {
    match (base, item) {
        (BaseType::Enum | BaseType::EnumList, Value::String(text)) => Some(Cow::Borrowed(text)),
        (BaseType::Boolean | BaseType::BooleanList, Value::Bool(flag)) => {
            Some(Cow::Borrowed(if *flag { "true" } else { "false" }))
        }
        (BaseType::Number | BaseType::NumberList, Value::Number(number)) if !number.is_nan() => {
            Some(Cow::Owned(number_to_text(*number)))
        }
        _ => None,
    }
}

fn indexed_keys(keys: &mut Vec<String>, base: BaseType, value: &Value) {
    let Value::Array(items) = value else {
        if let Some(key) = indexed_key(base, value) {
            keys.push(key.into_owned());
        }
        return;
    };
    for item in items {
        let Some(key) = indexed_key(base, item) else {
            continue;
        };
        if !keys.iter().any(|held| *held == key) {
            keys.push(key.into_owned());
        }
    }
}

fn document_keys(keys: &mut Vec<String>, indexed: Option<BaseType>, value: &Value) {
    keys.clear();
    if value.is_null() {
        return;
    }
    match (indexed, value) {
        (Some(base), _) => indexed_keys(keys, base, value),
        (None, Value::Array(items)) => keys.extend(items.iter().map(value_key)),
        (None, _) => keys.push(value_key(value)),
    }
}

fn facet_column(
    entry: &SegmentEntry,
    field: &str,
    indexed: Option<BaseType>,
) -> Result<Arc<FacetColumn>> {
    entry.derived().facet_keys.column(
        |(held_field, held_base)| held_field == field && *held_base == indexed,
        || (field.to_string(), indexed),
        entry.capacity() as usize,
        |column, range| {
            let reader = FieldReader::of(entry, field)?;
            let mut keys = Vec::new();
            for ordinal in range {
                match reader.get(ordinal as u32) {
                    Some(value) => document_keys(&mut keys, indexed, &value),
                    None => keys.clear(),
                }
                column.push_document(keys.iter().map(String::as_str));
            }
            Ok(())
        },
    )
}

fn value_counts(
    base: Option<BaseType>,
    field: &str,
    matched: &[MatchedSegment<'_>],
) -> Result<HashMap<String, u64>> {
    let indexed = base.filter(|base| is_indexed(*base));
    let mut counts: HashMap<String, u64> = HashMap::new();
    let mut tallies: Vec<u64> = Vec::new();
    for segment in matched {
        let column = facet_column(segment.entry, field, indexed)?;
        tallies.clear();
        tallies.resize(column.names().len(), 0);
        for ordinal in matched_ordinals(&segment.words) {
            for id in column.ids(ordinal) {
                if let Some(tally) = tallies.get_mut(*id as usize) {
                    *tally += 1;
                }
            }
        }
        for (name, tally) in column.names().iter().zip(&tallies) {
            if *tally > 0 {
                *counts.entry(name.clone()).or_insert(0) += tally;
            }
        }
    }
    Ok(counts)
}

fn in_range(number: f64, from: f64, to: f64) -> bool {
    number >= from && number < to
}

fn holds_value_in_range(value: &Value, declared: bool, from: f64, to: f64) -> bool {
    match value {
        Value::Number(number) => in_range(*number, from, to),
        Value::Array(items) if declared => items
            .iter()
            .any(|item| matches!(item, Value::Number(number) if in_range(*number, from, to))),
        Value::Array(items) => items
            .iter()
            .any(|item| in_range(javascript_to_number(item), from, to)),
        _ => false,
    }
}

fn range_counts(
    declared: bool,
    ranges: &[(f64, f64)],
    readers: &[(FieldReader, &[u32])],
) -> HashMap<String, u64> {
    let mut counts = HashMap::new();
    for &(from, to) in ranges {
        let label = format!("{}-{}", number_to_text(from), number_to_text(to));
        let mut count = 0u64;
        for (reader, words) in readers {
            for ordinal in matched_ordinals(words) {
                let held = reader.get(ordinal);
                if held.is_some_and(|value| holds_value_in_range(&value, declared, from, to)) {
                    count += 1;
                }
            }
        }
        counts.insert(label, count);
    }
    counts
}

fn kept_values(limit: Option<usize>) -> Option<usize> {
    limit.filter(|limit| *limit > 0)
}

fn ordered_result(counts: HashMap<String, u64>, spec: &FacetSpec) -> FacetResult {
    let ascending = spec.sort == Some(SortDirection::Asc);
    let mut ordered: Vec<(String, u64)> = counts.into_iter().collect();
    ordered.sort_by(|left, right| {
        let by_count = match ascending {
            true => left.1.cmp(&right.1),
            false => right.1.cmp(&left.1),
        };
        match by_count {
            Ordering::Equal => left.0.cmp(&right.0),
            other => other,
        }
    });
    let kept = kept_values(spec.limit)
        .unwrap_or(ordered.len())
        .min(ordered.len());
    let error_bound = ordered[kept..]
        .iter()
        .map(|(_, count)| *count)
        .max()
        .unwrap_or(0);
    ordered.truncate(kept);
    FacetResult {
        count: ordered.len(),
        values: ordered,
        error_bound,
    }
}

fn spec_of<'p>(params: &'p QueryParams, field: &str) -> Option<&'p FacetSpec> {
    params
        .facets
        .as_deref()?
        .iter()
        .rev()
        .find(|(held, _)| held == field)
        .map(|(_, spec)| spec)
}

fn dedupe_ranges(ranges: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let mut kept: Vec<(f64, f64)> = Vec::with_capacity(ranges.len());
    for &(from, to) in ranges.iter().rev() {
        let label = (number_to_text(from), number_to_text(to));
        if !kept.iter().any(|&(held_from, held_to)| {
            (number_to_text(held_from), number_to_text(held_to)) == label
        }) {
            kept.push((from, to));
        }
    }
    kept
}

pub(crate) fn count_facets(
    index: &IndexState,
    params: &QueryParams,
    matched: &[MatchedSegment<'_>],
) -> Result<Vec<(String, FacetResult)>> {
    let fields = distinct_facet_fields(params);
    let mut results = Vec::with_capacity(fields.len());
    for field in fields {
        let Some(spec) = spec_of(params, field) else {
            continue;
        };
        let base = index
            .schema
            .field_type(field)
            .map(|field_type| field_type.base);
        let numeric = matches!(base, None | Some(BaseType::Number | BaseType::NumberList));
        let counts = match spec.ranges.as_deref() {
            Some(ranges) if numeric => {
                let readers = matched
                    .iter()
                    .map(|segment| {
                        Ok((
                            FieldReader::of(segment.entry, field)?,
                            segment.words.as_ref(),
                        ))
                    })
                    .collect::<Result<Vec<(FieldReader, &[u32])>>>()?;
                range_counts(base.is_some(), &dedupe_ranges(ranges), &readers)
            }
            _ => value_counts(base, field, matched)?,
        };
        results.push((field.to_string(), ordered_result(counts, spec)));
    }
    Ok(results)
}
