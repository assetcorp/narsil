use std::ffi::c_void;
use std::sync::Arc;

use super::source::{EnumView, FilterSource, GeoView, NumericView, empty_bits, set_bit};
use crate::error::Result;
use crate::ffi;
use crate::geo::location_code;
use crate::index::derived::SortedNumbers;
use crate::index::segment::{SegmentData, SegmentEntry};
use crate::index::tail::TailSegment;
use crate::schema::BaseType;

pub(super) enum Numbers<'s> {
    Borrowed {
        values: &'s [f64],
        ordinals: &'s [u32],
    },
    Shared(Arc<SortedNumbers>),
    Owned {
        values: Vec<f64>,
        ordinals: Vec<u32>,
    },
}

impl Numbers<'_> {
    fn slices(&self) -> (&[f64], &[u32]) {
        match self {
            Numbers::Borrowed { values, ordinals } => (values, ordinals),
            Numbers::Shared(sorted) => (&sorted.values, &sorted.ordinals),
            Numbers::Owned { values, ordinals } => (values, ordinals),
        }
    }
}

pub(super) struct EnumRegions {
    units: Vec<u16>,
    offsets: Vec<u32>,
    posting_offsets: Vec<u32>,
    postings: Vec<u32>,
    suffix_order: Vec<u32>,
}

pub(super) struct GeoRegions {
    codes: Vec<u64>,
    lat: Vec<f64>,
    lon: Vec<f64>,
    ordinals: Vec<u32>,
}

pub(super) enum FieldIndex<'s> {
    Absent,
    Numbers(Numbers<'s>),
    Booleans {
        true_bits: Vec<u32>,
        false_bits: Vec<u32>,
    },
    Enums(EnumRegions),
    Geo(GeoRegions),
}

pub(super) struct FieldRegions<'s> {
    pub(super) present: Vec<u32>,
    pub(super) index: FieldIndex<'s>,
}

fn region<T>(values: &[T]) -> ffi::narsil_filter_region {
    ffi::narsil_filter_region {
        data: values.as_ptr().cast::<c_void>(),
        length: values.len(),
    }
}

impl FieldRegions<'_> {
    pub(super) fn native(&self) -> ffi::narsil_filter_field {
        let mut regions = [region::<u32>(&[]); ffi::NARSIL_FILTER_FIELD_REGIONS];
        regions[0] = region(&self.present);
        let (kind, held) = match &self.index {
            FieldIndex::Absent => (ffi::NARSIL_FILTER_ABSENT, vec![]),
            FieldIndex::Numbers(numbers) => {
                let (values, ordinals) = numbers.slices();
                (
                    ffi::NARSIL_FILTER_NUMERIC,
                    vec![region(values), region(ordinals)],
                )
            }
            FieldIndex::Booleans {
                true_bits,
                false_bits,
            } => (
                ffi::NARSIL_FILTER_BOOLEAN,
                vec![region(true_bits), region(false_bits)],
            ),
            FieldIndex::Enums(enums) => (
                ffi::NARSIL_FILTER_ENUM,
                vec![
                    region(&enums.units),
                    region(&enums.offsets),
                    region(&enums.posting_offsets),
                    region(&enums.postings),
                    region(&enums.suffix_order),
                ],
            ),
            FieldIndex::Geo(geo) => (
                ffi::NARSIL_FILTER_GEO,
                vec![
                    region(&geo.codes),
                    region(&geo.lat),
                    region(&geo.lon),
                    region(&geo.ordinals),
                ],
            ),
        };
        let region_count = 1 + held.len();
        for (at, held) in held.into_iter().enumerate() {
            regions[at + 1] = held;
        }
        ffi::narsil_filter_field {
            kind,
            region_count,
            regions,
        }
    }
}

pub(super) fn source_of(entry: &SegmentEntry) -> &dyn FilterSource {
    match &entry.data {
        SegmentData::Frozen(segment) => segment.as_ref(),
        SegmentData::Tail(tail) => tail.as_ref(),
    }
}

pub(super) fn present_bits(entry: &SegmentEntry, path: &str, base: BaseType) -> Vec<u32> {
    let source = source_of(entry);
    let mut bits = empty_bits(entry.capacity());
    match base {
        BaseType::Number => {
            if let Some(view) = source.numeric(path) {
                view.documents_into(&mut bits);
            }
        }
        BaseType::Boolean => {
            if let Some(view) = source.booleans(path) {
                for &ordinal in view.true_documents.iter().chain(view.false_documents) {
                    set_bit(&mut bits, ordinal);
                }
            }
        }
        BaseType::Enum => {
            if let Some(view) = source.enums(path) {
                view.documents_into(&mut bits);
            }
        }
        BaseType::Geopoint => {
            if let Some(view) = source.geopoints(path) {
                view.for_each_point(|ordinal, _, _| set_bit(&mut bits, ordinal));
            }
        }
        BaseType::Vector => {}
        _ => {
            if let Some(view) = source.sizes(path) {
                view.documents_into(&mut bits);
            }
        }
    }
    bits
}

fn tail_numbers(
    entry: &SegmentEntry,
    tail: &TailSegment,
    path: &str,
) -> Result<Arc<SortedNumbers>> {
    let entries = tail
        .columns
        .numeric
        .get(path)
        .map_or(&[][..], Vec::as_slice);
    entry.derived().sorted_numbers.column(
        |held| held == path,
        || path.to_string(),
        tail.len(),
        |sorted, range| {
            let start = entries.partition_point(|(ordinal, _)| (*ordinal as usize) < range.start);
            let end = entries.partition_point(|(ordinal, _)| (*ordinal as usize) < range.end);
            sorted.add(&entries[start..end], range.end);
            Ok(())
        },
    )
}

fn sorted_numbers(view: Option<NumericView<'_>>) -> Numbers<'_> {
    match view {
        Some(NumericView::Sorted { documents, values }) => Numbers::Borrowed {
            values,
            ordinals: documents,
        },
        Some(NumericView::Unsorted(entries)) => {
            let mut rows = entries.to_vec();
            rows.sort_by(|left, right| left.1.total_cmp(&right.1));
            Numbers::Owned {
                values: rows.iter().map(|row| row.1).collect(),
                ordinals: rows.iter().map(|row| row.0).collect(),
            }
        }
        None => Numbers::Owned {
            values: Vec::new(),
            ordinals: Vec::new(),
        },
    }
}

fn numeric_index<'s>(entry: &'s SegmentEntry, path: &str) -> Result<Numbers<'s>> {
    match &entry.data {
        SegmentData::Tail(tail) if tail.columns.numeric.contains_key(path) => {
            Ok(Numbers::Shared(tail_numbers(entry, tail, path)?))
        }
        _ => Ok(sorted_numbers(source_of(entry).numeric(path))),
    }
}

fn bits_of(documents: &[u32], capacity: u32) -> Vec<u32> {
    let mut bits = empty_bits(capacity.max(1));
    for &ordinal in documents {
        set_bit(&mut bits, ordinal);
    }
    bits
}

fn enum_regions(view: Option<EnumView<'_>>) -> EnumRegions {
    let mut values: Vec<(Vec<u16>, &[u32])> = Vec::new();
    if let Some(view) = view {
        view.for_each_value(|value, documents| {
            values.push((value.encode_utf16().collect(), documents))
        });
    }
    values.sort_by(|left, right| left.0.cmp(&right.0));
    let mut regions = EnumRegions {
        units: Vec::new(),
        offsets: vec![0],
        posting_offsets: vec![0],
        postings: Vec::new(),
        suffix_order: (0..values.len() as u32).collect(),
    };
    for (units, documents) in &values {
        regions.units.extend_from_slice(units);
        regions.offsets.push(regions.units.len() as u32);
        regions.postings.extend_from_slice(documents);
        regions.posting_offsets.push(regions.postings.len() as u32);
    }
    regions.suffix_order.sort_by(|&left, &right| {
        let left = &values[left as usize].0;
        let right = &values[right as usize].0;
        left.iter().rev().cmp(right.iter().rev())
    });
    regions
}

fn geo_regions(view: Option<GeoView<'_>>) -> GeoRegions {
    let mut rows: Vec<(u64, u32, f64, f64)> = Vec::new();
    if let Some(view) = view {
        view.for_each_point(|ordinal, lat, lon| {
            rows.push((location_code(lat, lon), ordinal, lat, lon))
        });
    }
    rows.sort_unstable_by_key(|row| (row.0, row.1));
    GeoRegions {
        codes: rows.iter().map(|row| row.0).collect(),
        lat: rows.iter().map(|row| row.2).collect(),
        lon: rows.iter().map(|row| row.3).collect(),
        ordinals: rows.iter().map(|row| row.1).collect(),
    }
}

pub(super) fn field_index<'s>(
    entry: &'s SegmentEntry,
    path: &str,
    base: BaseType,
    size: bool,
) -> Result<FieldIndex<'s>> {
    let source = source_of(entry);
    if size {
        return Ok(FieldIndex::Numbers(sorted_numbers(source.sizes(path))));
    }
    Ok(match base {
        BaseType::Number | BaseType::NumberList => FieldIndex::Numbers(numeric_index(entry, path)?),
        BaseType::Boolean | BaseType::BooleanList => {
            let capacity = entry.capacity();
            let (truthy, falsy) = source.booleans(path).map_or((&[][..], &[][..]), |view| {
                (view.true_documents, view.false_documents)
            });
            FieldIndex::Booleans {
                true_bits: bits_of(truthy, capacity),
                false_bits: bits_of(falsy, capacity),
            }
        }
        BaseType::Enum | BaseType::EnumList => FieldIndex::Enums(enum_regions(source.enums(path))),
        BaseType::Geopoint => FieldIndex::Geo(geo_regions(source.geopoints(path))),
        _ => FieldIndex::Absent,
    })
}
