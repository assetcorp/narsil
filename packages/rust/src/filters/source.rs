use std::borrow::Cow;
use std::cmp::Ordering;
use std::collections::BTreeMap;

use super::constants::SORT_VALUE_MAX_CODE_POINTS;
use crate::error::Result;
use crate::format::keyword_columns::EnumColumn;
use crate::pattern::PatternIndexRef;
use crate::value::Value;

pub(crate) fn bitset_words(capacity: u32) -> usize {
    capacity.div_ceil(32) as usize
}

pub(crate) fn empty_bits(capacity: u32) -> Vec<u32> {
    vec![0; bitset_words(capacity)]
}

#[inline]
pub(crate) fn set_bit(bits: &mut [u32], ordinal: u32) {
    if let Some(word) = bits.get_mut((ordinal >> 5) as usize) {
        *word |= 1 << (ordinal & 31);
    }
}

#[inline]
pub(crate) fn has_bit(bits: &[u32], ordinal: u32) -> bool {
    bits.get((ordinal >> 5) as usize)
        .is_some_and(|word| word & (1 << (ordinal & 31)) != 0)
}

pub(crate) fn and_into(target: &mut [u32], other: &[u32]) {
    for (at, word) in target.iter_mut().enumerate() {
        *word &= other.get(at).copied().unwrap_or(0);
    }
}

pub(crate) fn and_not_into(target: &mut [u32], other: &[u32]) {
    for (word, removed) in target.iter_mut().zip(other) {
        *word &= !removed;
    }
}

pub(crate) fn or_into(target: &mut [u32], other: &[u32]) {
    for (word, added) in target.iter_mut().zip(other) {
        *word |= added;
    }
}

pub(crate) fn is_empty_bits(bits: &[u32]) -> bool {
    bits.iter().all(|word| *word == 0)
}

#[derive(Clone, Copy)]
pub(crate) enum NumericView<'a> {
    Sorted {
        documents: &'a [u32],
        values: &'a [f64],
    },
    Unsorted(&'a [(u32, f64)]),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Comparison {
    Eq(f64),
    Gt(f64),
    Gte(f64),
    Lt(f64),
    Lte(f64),
    Between(f64, f64),
}

impl Comparison {
    fn holds(self, value: f64) -> bool {
        match self {
            Comparison::Eq(bound) => value == bound,
            Comparison::Gt(bound) => value > bound,
            Comparison::Gte(bound) => value >= bound,
            Comparison::Lt(bound) => value < bound,
            Comparison::Lte(bound) => value <= bound,
            Comparison::Between(low, high) => value >= low && value <= high,
        }
    }

    fn range_in(self, values: &[f64]) -> (usize, usize) {
        let below = |bound: f64| values.partition_point(|value| *value < bound);
        let through = |bound: f64| values.partition_point(|value| *value <= bound);
        match self {
            Comparison::Eq(bound) => (below(bound), through(bound)),
            Comparison::Gt(bound) => (through(bound), values.len()),
            Comparison::Gte(bound) => (below(bound), values.len()),
            Comparison::Lt(bound) => (0, below(bound)),
            Comparison::Lte(bound) => (0, through(bound)),
            Comparison::Between(low, high) => (below(low), through(high)),
        }
    }
}

impl NumericView<'_> {
    pub(crate) fn documents_into(self, bits: &mut [u32]) {
        match self {
            NumericView::Sorted { documents, .. } => {
                for &ordinal in documents {
                    set_bit(bits, ordinal);
                }
            }
            NumericView::Unsorted(entries) => {
                for &(ordinal, _) in entries {
                    set_bit(bits, ordinal);
                }
            }
        }
    }

    pub(crate) fn select_into(self, comparison: Comparison, bits: &mut [u32]) {
        match self {
            NumericView::Sorted { documents, values } => {
                let (start, end) = comparison.range_in(values);
                if start < end {
                    for &ordinal in documents.get(start..end).unwrap_or(&[]) {
                        set_bit(bits, ordinal);
                    }
                }
            }
            NumericView::Unsorted(entries) => {
                for &(ordinal, value) in entries {
                    if comparison.holds(value) {
                        set_bit(bits, ordinal);
                    }
                }
            }
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) struct BooleanView<'a> {
    pub(crate) true_documents: &'a [u32],
    pub(crate) false_documents: &'a [u32],
}

impl<'a> BooleanView<'a> {
    pub(crate) fn documents_of(self, value: bool) -> &'a [u32] {
        if value {
            self.true_documents
        } else {
            self.false_documents
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) enum EnumView<'a> {
    Column(&'a EnumColumn),
    Map(&'a BTreeMap<String, Vec<u32>>),
}

impl<'a> EnumView<'a> {
    fn for_each_value(self, mut visit: impl FnMut(&str, &'a [u32])) {
        match self {
            EnumView::Column(column) => {
                for (at, value) in column.values.iter().enumerate() {
                    let start = column.offsets.get(at).copied().unwrap_or(0) as usize;
                    let end = column.offsets.get(at + 1).copied().unwrap_or(0) as usize;
                    visit(value, column.documents.get(start..end).unwrap_or(&[]));
                }
            }
            EnumView::Map(map) => {
                for (value, documents) in map {
                    visit(value, documents);
                }
            }
        }
    }

    pub(crate) fn documents_into(self, bits: &mut [u32]) {
        self.select_into(|_| true, bits);
    }

    pub(crate) fn select_into(self, mut wanted: impl FnMut(&str) -> bool, bits: &mut [u32]) {
        self.for_each_value(|value, documents| {
            if wanted(value) {
                for &ordinal in documents {
                    set_bit(bits, ordinal);
                }
            }
        });
    }
}

#[derive(Clone, Copy)]
pub(crate) enum GeoView<'a> {
    Columns {
        documents: &'a [u32],
        latitudes: &'a [f64],
        longitudes: &'a [f64],
    },
    Tuples(&'a [(u32, f64, f64)]),
}

impl GeoView<'_> {
    pub(crate) fn for_each_point(self, mut visit: impl FnMut(u32, f64, f64)) {
        match self {
            GeoView::Columns {
                documents,
                latitudes,
                longitudes,
            } => {
                for ((&ordinal, &lat), &lon) in documents.iter().zip(latitudes).zip(longitudes) {
                    visit(ordinal, lat, lon);
                }
            }
            GeoView::Tuples(points) => {
                for &(ordinal, lat, lon) in points {
                    visit(ordinal, lat, lon);
                }
            }
        }
    }
}

pub(crate) enum PatternSource<'a> {
    Index(PatternIndexRef<'a>),
    Values(&'a [(u32, Value)]),
}

#[derive(Debug, Clone)]
pub(crate) enum SortValue<'a> {
    Number(f64),
    Text(Cow<'a, str>),
    Boolean(bool),
}

impl SortValue<'_> {
    /// Returns the value with its text copied, so that it outlives the stored document that it came from.
    pub(crate) fn into_owned(self) -> SortValue<'static> {
        match self {
            SortValue::Number(number) => SortValue::Number(number),
            SortValue::Text(text) => SortValue::Text(Cow::Owned(text.into_owned())),
            SortValue::Boolean(flag) => SortValue::Boolean(flag),
        }
    }
}

pub(crate) fn truncated_sort_text(text: &str) -> &str {
    match text.char_indices().nth(SORT_VALUE_MAX_CODE_POINTS) {
        Some((at, _)) => &text[..at],
        None => text,
    }
}

pub(crate) fn reduced_min<'a>(
    current: Option<SortValue<'a>>,
    candidate: SortValue<'a>,
) -> Option<SortValue<'a>> {
    let candidate = match candidate {
        SortValue::Text(Cow::Borrowed(text)) => {
            SortValue::Text(Cow::Borrowed(truncated_sort_text(text)))
        }
        SortValue::Text(Cow::Owned(text)) => {
            SortValue::Text(Cow::Owned(truncated_sort_text(&text).to_string()))
        }
        SortValue::Number(number) if !number.is_finite() => return current,
        other => other,
    };
    match current {
        Some(chosen) if compare_sort_values(&candidate, &chosen) != Ordering::Less => Some(chosen),
        _ => Some(candidate),
    }
}

fn type_rank(value: &SortValue<'_>) -> u8 {
    match value {
        SortValue::Number(_) => 0,
        SortValue::Text(_) => 1,
        SortValue::Boolean(_) => 2,
    }
}

pub(crate) fn compare_sort_values(left: &SortValue<'_>, right: &SortValue<'_>) -> Ordering {
    match (left, right) {
        (SortValue::Number(a), SortValue::Number(b)) => a.partial_cmp(b).unwrap_or(Ordering::Equal),
        (SortValue::Text(a), SortValue::Text(b)) => {
            crate::pattern::fold::compare_sort_strings(a, b)
        }
        (SortValue::Boolean(a), SortValue::Boolean(b)) => a.cmp(b),
        _ => type_rank(left).cmp(&type_rank(right)),
    }
}

pub(crate) trait FilterSource {
    fn capacity(&self) -> u32;
    fn numeric(&self, field: &str) -> Option<NumericView<'_>>;
    fn sizes(&self, field: &str) -> Option<NumericView<'_>>;
    fn booleans(&self, field: &str) -> Option<BooleanView<'_>>;
    fn enums(&self, field: &str) -> Option<EnumView<'_>>;
    fn geopoints(&self, field: &str) -> Option<GeoView<'_>>;
    fn patterns(&self, field: &str) -> Option<PatternSource<'_>>;
    fn for_each_text(
        &self,
        field: &str,
        ordinal: u32,
        visit: &mut dyn FnMut(&str) -> Result<bool>,
    ) -> Result<()>;
    fn min_sort_value(&self, field: &str, ordinal: u32) -> Result<Option<SortValue<'_>>>;

    fn text_range_into(
        &self,
        field: &str,
        lower: Option<(&str, bool)>,
        upper: Option<(&str, bool)>,
        live: &[u32],
        bits: &mut [u32],
    ) -> Result<()> {
        for ordinal in 0..self.capacity() {
            if !has_bit(live, ordinal) {
                continue;
            }
            let Some(value) = self.min_sort_value(field, ordinal)? else {
                continue;
            };
            if within_text_bounds(value, lower, upper) {
                set_bit(bits, ordinal);
            }
        }
        Ok(())
    }
}

fn within_text_bounds(
    value: SortValue<'_>,
    lower: Option<(&str, bool)>,
    upper: Option<(&str, bool)>,
) -> bool {
    if let Some((bound, inclusive)) = lower {
        match compare_sort_values(&value, &SortValue::Text(Cow::Borrowed(bound))) {
            Ordering::Less => return false,
            Ordering::Equal if !inclusive => return false,
            _ => {}
        }
    }
    if let Some((bound, inclusive)) = upper {
        match compare_sort_values(&value, &SortValue::Text(Cow::Borrowed(bound))) {
            Ordering::Greater => return false,
            Ordering::Equal if !inclusive => return false,
            _ => {}
        }
    }
    true
}
