use std::collections::BTreeMap;

use crate::format::keyword_columns::EnumColumn;

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
}

#[derive(Clone, Copy)]
pub(crate) struct BooleanView<'a> {
    pub(crate) true_documents: &'a [u32],
    pub(crate) false_documents: &'a [u32],
}

#[derive(Clone, Copy)]
pub(crate) enum EnumView<'a> {
    Column(&'a EnumColumn),
    Map(&'a BTreeMap<String, Vec<u32>>),
}

impl<'a> EnumView<'a> {
    pub(crate) fn for_each_value(self, mut visit: impl FnMut(&'a str, &'a [u32])) {
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
        self.for_each_value(|_, documents| {
            for &ordinal in documents {
                set_bit(bits, ordinal);
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

pub(crate) trait FilterSource {
    fn numeric(&self, field: &str) -> Option<NumericView<'_>>;
    fn sizes(&self, field: &str) -> Option<NumericView<'_>>;
    fn booleans(&self, field: &str) -> Option<BooleanView<'_>>;
    fn enums(&self, field: &str) -> Option<EnumView<'_>>;
    fn geopoints(&self, field: &str) -> Option<GeoView<'_>>;
}
