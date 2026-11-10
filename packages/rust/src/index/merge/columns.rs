use std::collections::HashMap;

use super::enum_columns::merge_enum_column;
use super::field_regions::{EMPTY_OFFSETS, field_source, merge_field_regions, source_region};
use super::field_targets::{BitTargets, GeoTargets, PatternTargets, ValueTargets};
use super::inputs::{MergeInput, damaged};
use super::tail_columns::InputColumns;
use crate::error::Result;
use crate::ffi;
use crate::filters::source::set_bit;
use crate::format::keyword_columns::{
    BooleanColumn, EnumColumn, GeopointColumn, PatternColumn, ValueColumn,
};
use crate::geo::location_code;
use crate::index::segment::bit_is_set;

/// The merged field columns of a segment, each kind in the order that the inputs first hold each field.
pub(crate) struct MergedColumns {
    pub(crate) numeric: Vec<ValueColumn>,
    pub(crate) sizes: Vec<ValueColumn>,
    pub(crate) boolean: Vec<BooleanColumn>,
    pub(crate) enums: Vec<EnumColumn>,
    pub(crate) geopoint: Vec<GeopointColumn>,
    pub(crate) pattern: Vec<PatternColumn>,
}

pub(super) type MergeColumns<'c> = [(InputColumns<'c>, &'c MergeInput<'c>)];

fn by_field<'c, T>(
    inputs: &'c MergeColumns<'c>,
    columns_of: impl Fn(&'c InputColumns<'c>) -> &'c [T],
    field_of: impl Fn(&T) -> &str,
) -> Vec<(&'c str, Vec<Option<&'c T>>)> {
    let mut groups: Vec<(&str, Vec<Option<&T>>)> = Vec::new();
    let mut slots: HashMap<&str, usize> = HashMap::new();
    for (at, (columns, _)) in inputs.iter().enumerate() {
        for column in columns_of(columns) {
            let field = field_of(column);
            let group = *slots.entry(field).or_insert_with(|| {
                groups.push((field, vec![None; inputs.len()]));
                groups.len() - 1
            });
            if let Some(slot) = groups
                .get_mut(group)
                .and_then(|(_, members)| members.get_mut(at))
            {
                *slot = Some(column);
            }
        }
    }
    groups
}

fn merge_values<'c>(
    inputs: &'c MergeColumns<'c>,
    document_count: u32,
    columns_of: impl Fn(&'c InputColumns<'c>) -> &'c [ValueColumn],
) -> Result<Vec<ValueColumn>> {
    let mut merged = Vec::new();
    for (field, members) in by_field(inputs, columns_of, |column| &column.field) {
        let sources: Vec<ffi::narsil_field_merge_source> = inputs
            .iter()
            .zip(&members)
            .map(|((_, input), column)| {
                let values = column.map_or(&[][..], |column| column.values.as_slice());
                let documents = column.map_or(&[][..], |column| column.documents.as_slice());
                field_source(input, &[source_region(values), source_region(documents)])
            })
            .collect();
        let rows: ValueTargets =
            merge_field_regions(ffi::NARSIL_MERGE_NUMERIC, &sources, document_count)?;
        merged.push(ValueColumn {
            field: field.to_string(),
            documents: rows.documents,
            values: rows.values,
        });
    }
    Ok(merged)
}

fn bitset(documents: &[u32], capacity: usize) -> Result<Vec<u32>> {
    let mut bits = vec![0u32; capacity.div_ceil(32).max(1)];
    for &ordinal in documents {
        if ordinal as usize >= capacity {
            return Err(damaged("holds a boolean entry past its documents"));
        }
        set_bit(&mut bits, ordinal);
    }
    Ok(bits)
}

fn set_ordinals(bits: &[u32], document_count: u32) -> Vec<u32> {
    (0..document_count)
        .filter(|&ordinal| bit_is_set(bits, ordinal))
        .collect()
}

fn merge_booleans<'c>(
    inputs: &'c MergeColumns<'c>,
    document_count: u32,
) -> Result<Vec<BooleanColumn>> {
    let mut merged = Vec::new();
    for (field, members) in by_field(inputs, |c| &c.boolean, |column| &column.field) {
        let mut held = Vec::with_capacity(inputs.len());
        for ((_, input), column) in inputs.iter().zip(&members) {
            let capacity = input.remap.len();
            let true_documents = column.map_or(&[][..], |column| column.true_documents.as_slice());
            let false_documents =
                column.map_or(&[][..], |column| column.false_documents.as_slice());
            held.push((
                bitset(true_documents, capacity)?,
                bitset(false_documents, capacity)?,
            ));
        }
        let sources: Vec<ffi::narsil_field_merge_source> = inputs
            .iter()
            .zip(&held)
            .map(|((_, input), (true_bits, false_bits))| {
                field_source(
                    input,
                    &[source_region(true_bits), source_region(false_bits)],
                )
            })
            .collect();
        let bits: BitTargets =
            merge_field_regions(ffi::NARSIL_MERGE_BOOLEAN, &sources, document_count)?;
        merged.push(BooleanColumn {
            field: field.to_string(),
            true_documents: set_ordinals(&bits.true_bits, document_count),
            false_documents: set_ordinals(&bits.false_bits, document_count),
        });
    }
    Ok(merged)
}

fn merge_geopoints<'c>(
    inputs: &'c MergeColumns<'c>,
    document_count: u32,
) -> Result<Vec<GeopointColumn>> {
    let mut merged = Vec::new();
    for (field, members) in by_field(inputs, |c| &c.geopoint, |column| &column.field) {
        let codes: Vec<Vec<u64>> = members
            .iter()
            .map(|column| {
                column.map_or_else(Vec::new, |column| {
                    column
                        .latitudes
                        .iter()
                        .zip(&column.longitudes)
                        .map(|(&latitude, &longitude)| location_code(latitude, longitude))
                        .collect()
                })
            })
            .collect();
        let sources: Vec<ffi::narsil_field_merge_source> = inputs
            .iter()
            .zip(members.iter().zip(&codes))
            .map(|((_, input), (column, codes))| {
                let latitudes = column.map_or(&[][..], |column| column.latitudes.as_slice());
                let longitudes = column.map_or(&[][..], |column| column.longitudes.as_slice());
                let documents = column.map_or(&[][..], |column| column.documents.as_slice());
                field_source(
                    input,
                    &[
                        source_region(codes),
                        source_region(latitudes),
                        source_region(longitudes),
                        source_region(documents),
                    ],
                )
            })
            .collect();
        let rows: GeoTargets =
            merge_field_regions(ffi::NARSIL_MERGE_GEO, &sources, document_count)?;
        merged.push(GeopointColumn {
            field: field.to_string(),
            documents: rows.documents,
            latitudes: rows.latitudes,
            longitudes: rows.longitudes,
        });
    }
    Ok(merged)
}

fn merge_patterns<'c>(
    inputs: &'c MergeColumns<'c>,
    document_count: u32,
) -> Result<Vec<PatternColumn>> {
    let mut merged = Vec::new();
    for (field, members) in by_field(inputs, |c| &c.pattern, |column| &column.field) {
        let sources: Vec<ffi::narsil_field_merge_source> = inputs
            .iter()
            .zip(&members)
            .map(|((_, input), column)| {
                let regions = match column {
                    Some(column) => [
                        source_region(&column.documents),
                        source_region(&column.runs),
                        source_region(&column.offsets),
                        source_region(&column.postings),
                    ],
                    None => [
                        source_region::<u32>(&[]),
                        source_region::<u32>(&[]),
                        source_region(&EMPTY_OFFSETS),
                        source_region::<u32>(&[]),
                    ],
                };
                field_source(input, &regions)
            })
            .collect();
        let runs: PatternTargets =
            merge_field_regions(ffi::NARSIL_MERGE_PATTERN, &sources, document_count)?;
        merged.push(PatternColumn {
            field: field.to_string(),
            documents: runs.documents,
            runs: runs.runs,
            offsets: runs.offsets,
            postings: runs.postings,
        });
    }
    Ok(merged)
}

pub(crate) fn merge_columns<'c>(
    inputs: &'c MergeColumns<'c>,
    document_count: u32,
) -> Result<MergedColumns> {
    let mut enums = Vec::new();
    for (field, members) in by_field(inputs, |c| &c.enums, |column| &column.field) {
        enums.push(merge_enum_column(inputs, field, &members, document_count)?);
    }
    Ok(MergedColumns {
        numeric: merge_values(inputs, document_count, |c| &c.numeric)?,
        sizes: merge_values(inputs, document_count, |c| &c.sizes)?,
        boolean: merge_booleans(inputs, document_count)?,
        enums,
        geopoint: merge_geopoints(inputs, document_count)?,
        pattern: merge_patterns(inputs, document_count)?,
    })
}
