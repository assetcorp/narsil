use std::collections::HashMap;
use std::sync::Arc;

use super::MatchedSegment;
use super::native::{
    NumericEntries, boolean_counts, enum_counts, number_counts, range_counts, stored_range_counts,
    value_counts,
};
use crate::error::Result;
use crate::filters::source::{
    BooleanView, EnumView, FilterSource, NumericView, empty_bits, set_bit,
};
use crate::index::derived::SortedNumbers;
use crate::index::segment::{SegmentData, SegmentEntry};
use crate::schema::BaseType;
use crate::value::number_to_text;

enum Numbers<'a> {
    Frozen {
        values: &'a [f64],
        ordinals: &'a [u32],
    },
    Tail(Arc<SortedNumbers>),
}

impl Numbers<'_> {
    fn entries(&self) -> NumericEntries<'_> {
        match self {
            Numbers::Frozen { values, ordinals } => NumericEntries { values, ordinals },
            Numbers::Tail(sorted) => NumericEntries {
                values: &sorted.values,
                ordinals: &sorted.ordinals,
            },
        }
    }
}

fn numbers_of<'a>(entry: &'a SegmentEntry, field: &str) -> Result<Option<Numbers<'a>>> {
    Ok(match &entry.data {
        SegmentData::Frozen(segment) => match segment.numeric(field) {
            Some(NumericView::Sorted { documents, values }) => Some(Numbers::Frozen {
                values,
                ordinals: documents,
            }),
            _ => None,
        },
        SegmentData::Tail(tail) => match tail.columns.numeric.contains_key(field) {
            true => Some(Numbers::Tail(tail.sorted_numbers(field)?)),
            false => None,
        },
    })
}

fn booleans_of<'a>(entry: &'a SegmentEntry, field: &str) -> Option<BooleanView<'a>> {
    match &entry.data {
        SegmentData::Frozen(segment) => segment.booleans(field),
        SegmentData::Tail(tail) => tail.booleans(field),
    }
}

fn enums_of<'a>(entry: &'a SegmentEntry, field: &str) -> Option<EnumView<'a>> {
    match &entry.data {
        SegmentData::Frozen(segment) => segment.enums(field),
        SegmentData::Tail(tail) => tail.enums(field),
    }
}

fn bits_of(documents: &[u32], capacity: u32) -> Vec<u32> {
    let mut bits = empty_bits(capacity);
    for ordinal in documents {
        set_bit(&mut bits, *ordinal);
    }
    bits
}

fn enum_buckets(view: EnumView<'_>, matched: &[u32]) -> Result<Vec<(String, u32)>> {
    let counts_of = |names: Vec<&str>, offsets: &[u32], postings: &[u32]| -> Result<_> {
        let counts = enum_counts(offsets, postings, matched)?;
        Ok(names
            .into_iter()
            .zip(counts)
            .filter(|(_, count)| *count > 0)
            .map(|(name, count)| (name.to_string(), count))
            .collect())
    };
    match view {
        EnumView::Column(column) => counts_of(
            column.values.iter().map(String::as_str).collect(),
            &column.offsets,
            &column.documents,
        ),
        EnumView::Map(values) => {
            let mut offsets = Vec::with_capacity(values.len() + 1);
            let mut postings = Vec::new();
            offsets.push(0);
            for documents in values.values() {
                postings.extend_from_slice(documents);
                offsets.push(postings.len() as u32);
            }
            counts_of(
                values.keys().map(String::as_str).collect(),
                &offsets,
                &postings,
            )
        }
    }
}

fn value_buckets(entry: &SegmentEntry, field: &str, matched: &[u32]) -> Result<Vec<(String, u32)>> {
    let stored = entry.core_stored_values(field)?;
    let mut buckets: Vec<(String, u32)> = Vec::new();
    let mut places: HashMap<String, usize> = HashMap::new();
    for (element, count) in value_counts(&stored, matched)? {
        let Some(key) = stored.bucket_key(element) else {
            continue;
        };
        match places.get(&key) {
            Some(&place) => buckets[place].1 = buckets[place].1.saturating_add(count),
            None => {
                places.insert(key.clone(), buckets.len());
                buckets.push((key, count));
            }
        }
    }
    Ok(buckets)
}

pub(super) fn segment_buckets(
    segment: &MatchedSegment<'_>,
    field: &str,
    base: Option<BaseType>,
) -> Result<Vec<(String, u32)>> {
    let entry = segment.entry;
    let matched = segment.words.as_ref();
    match base {
        Some(BaseType::Enum | BaseType::EnumList) => {
            if let Some(view) = enums_of(entry, field) {
                return enum_buckets(view, matched);
            }
        }
        Some(BaseType::Boolean | BaseType::BooleanList) => {
            if let Some(view) = booleans_of(entry, field) {
                let capacity = entry.capacity();
                let [true_count, false_count] = boolean_counts(
                    &bits_of(view.true_documents, capacity),
                    &bits_of(view.false_documents, capacity),
                    matched,
                )?;
                return Ok([("true", true_count), ("false", false_count)]
                    .into_iter()
                    .filter(|(_, count)| *count > 0)
                    .map(|(key, count)| (key.to_string(), count))
                    .collect());
            }
        }
        Some(BaseType::Number | BaseType::NumberList) => {
            if let Some(numbers) = numbers_of(entry, field)? {
                return Ok(number_counts(&numbers.entries(), matched)?
                    .into_iter()
                    .map(|(value, count)| (number_to_text(value), count))
                    .collect());
            }
        }
        _ => {}
    }
    value_buckets(entry, field, matched)
}

pub(super) fn segment_ranges(
    segment: &MatchedSegment<'_>,
    field: &str,
    base: Option<BaseType>,
    bounds: &[f64],
) -> Result<Vec<u32>> {
    let entry = segment.entry;
    let matched = segment.words.as_ref();
    if matches!(base, Some(BaseType::Number | BaseType::NumberList))
        && let Some(numbers) = numbers_of(entry, field)?
    {
        return range_counts(&numbers.entries(), matched, bounds);
    }
    let stored = entry.core_stored_values(field)?;
    stored_range_counts(&stored, matched, bounds)
}
