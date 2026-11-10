use std::cmp::Ordering;
use std::collections::{BTreeSet, HashMap};

use super::inputs::{MergeInput, as_u32};
use super::pattern::merge_pattern_columns;
use super::tail_columns::InputColumns;
use crate::error::Result;
use crate::format::keyword_columns::{
    BooleanColumn, EnumColumn, GeopointColumn, PatternColumn, ValueColumn,
};

/// The merged field columns of a segment, each kind in the order that the inputs first hold each field.
pub(crate) struct MergedColumns {
    pub(crate) numeric: Vec<ValueColumn>,
    pub(crate) sizes: Vec<ValueColumn>,
    pub(crate) boolean: Vec<BooleanColumn>,
    pub(crate) enums: Vec<EnumColumn>,
    pub(crate) geopoint: Vec<GeopointColumn>,
    pub(crate) pattern: Vec<PatternColumn>,
}

/// Groups the columns of one kind by field across the inputs, with the fields in the order that the inputs first
/// hold them and each field's columns in input order.
fn by_field<'c, T>(
    inputs: &'c [(InputColumns<'c>, &'c MergeInput<'c>)],
    columns_of: impl Fn(&'c InputColumns<'c>) -> &'c [T],
    field_of: impl Fn(&T) -> &str,
) -> Vec<(&'c str, Vec<(&'c T, &'c MergeInput<'c>)>)> {
    let mut groups: Vec<(&str, Vec<(&T, &MergeInput<'_>)>)> = Vec::new();
    let mut slots: HashMap<&str, usize> = HashMap::new();
    for (columns, input) in inputs {
        for column in columns_of(columns) {
            let field = field_of(column);
            let at = *slots.entry(field).or_insert_with(|| {
                groups.push((field, Vec::new()));
                groups.len() - 1
            });
            if let Some((_, members)) = groups.get_mut(at) {
                members.push((column, *input));
            }
        }
    }
    groups
}

fn remapped(documents: &[u32], input: &MergeInput<'_>, out: &mut Vec<u32>) {
    out.extend(
        documents
            .iter()
            .filter_map(|&ordinal| input.target(ordinal)),
    );
}

fn merge_values(groups: Vec<(&str, Vec<(&ValueColumn, &MergeInput<'_>)>)>) -> Vec<ValueColumn> {
    groups
        .into_iter()
        .map(|(field, members)| {
            let mut rows: Vec<(f64, u32)> = Vec::new();
            for (column, input) in members {
                for (&ordinal, &value) in column.documents.iter().zip(&column.values) {
                    if let Some(target) = input.target(ordinal) {
                        rows.push((value, target));
                    }
                }
            }
            rows.sort_by(|left, right| {
                match left.0.partial_cmp(&right.0).unwrap_or(Ordering::Equal) {
                    Ordering::Equal => left.1.cmp(&right.1),
                    order => order,
                }
            });
            ValueColumn {
                field: field.to_string(),
                documents: rows.iter().map(|row| row.1).collect(),
                values: rows.iter().map(|row| row.0).collect(),
            }
        })
        .collect()
}

fn merge_booleans(
    groups: Vec<(&str, Vec<(&BooleanColumn, &MergeInput<'_>)>)>,
) -> Vec<BooleanColumn> {
    groups
        .into_iter()
        .map(|(field, members)| {
            let mut merged = BooleanColumn {
                field: field.to_string(),
                true_documents: Vec::new(),
                false_documents: Vec::new(),
            };
            for (column, input) in members {
                remapped(&column.true_documents, input, &mut merged.true_documents);
                remapped(&column.false_documents, input, &mut merged.false_documents);
            }
            merged
        })
        .collect()
}

fn merge_enums(
    groups: Vec<(&str, Vec<(&EnumColumn, &MergeInput<'_>)>)>,
) -> Result<Vec<EnumColumn>> {
    let mut out = Vec::with_capacity(groups.len());
    for (field, members) in groups {
        let values: BTreeSet<&str> = members
            .iter()
            .flat_map(|(column, _)| column.values.iter().map(String::as_str))
            .collect();
        let slots: Vec<HashMap<&str, usize>> = members
            .iter()
            .map(|(column, _)| {
                column
                    .values
                    .iter()
                    .enumerate()
                    .map(|(at, value)| (value.as_str(), at))
                    .collect()
            })
            .collect();
        let mut merged = EnumColumn {
            field: field.to_string(),
            values: Vec::with_capacity(values.len()),
            offsets: Vec::with_capacity(values.len() + 1),
            documents: Vec::new(),
        };
        merged.offsets.push(0);
        for value in values {
            for ((column, input), slot) in members.iter().zip(&slots) {
                let Some(&at) = slot.get(value) else {
                    continue;
                };
                let start = column.offsets.get(at).copied().unwrap_or(0) as usize;
                let end = column.offsets.get(at + 1).copied().unwrap_or(0) as usize;
                remapped(
                    column.documents.get(start..end).unwrap_or(&[]),
                    input,
                    &mut merged.documents,
                );
            }
            merged.values.push(value.to_string());
            merged
                .offsets
                .push(as_u32(merged.documents.len(), "enum entries")?);
        }
        out.push(merged);
    }
    Ok(out)
}

fn merge_geopoints(
    groups: Vec<(&str, Vec<(&GeopointColumn, &MergeInput<'_>)>)>,
) -> Vec<GeopointColumn> {
    groups
        .into_iter()
        .map(|(field, members)| {
            let mut merged = GeopointColumn {
                field: field.to_string(),
                documents: Vec::new(),
                latitudes: Vec::new(),
                longitudes: Vec::new(),
            };
            for (column, input) in members {
                let rows = column
                    .documents
                    .iter()
                    .zip(column.latitudes.iter().zip(&column.longitudes));
                for (&ordinal, (&latitude, &longitude)) in rows {
                    if let Some(target) = input.target(ordinal) {
                        merged.documents.push(target);
                        merged.latitudes.push(latitude);
                        merged.longitudes.push(longitude);
                    }
                }
            }
            merged
        })
        .collect()
}

/// Joins the field columns of the inputs as the reference merge does: numeric and size rows sorted by value and
/// then by document, boolean and geopoint rows in input order, enum values in code point order, and pattern runs
/// merged in code point order.
pub(crate) fn merge_columns<'c>(
    inputs: &'c [(InputColumns<'c>, &'c MergeInput<'c>)],
) -> Result<MergedColumns> {
    let numeric = merge_values(by_field(inputs, |c| &c.numeric, |c| &c.field));
    let sizes = merge_values(by_field(inputs, |c| &c.sizes, |c| &c.field));
    let boolean = merge_booleans(by_field(inputs, |c| &c.boolean, |c| &c.field));
    let enums = merge_enums(by_field(inputs, |c| &c.enums, |c| &c.field))?;
    let geopoint = merge_geopoints(by_field(inputs, |c| &c.geopoint, |c| &c.field));
    let mut pattern = Vec::new();
    for (field, members) in by_field(inputs, |c| &c.pattern, |c| &c.field) {
        pattern.push(merge_pattern_columns(field, &members)?);
    }
    Ok(MergedColumns {
        numeric,
        sizes,
        boolean,
        enums,
        geopoint,
        pattern,
    })
}
