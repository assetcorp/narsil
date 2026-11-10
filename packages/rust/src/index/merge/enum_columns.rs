use super::columns::MergeColumns;
use super::field_regions::{EMPTY_OFFSETS, field_source, merge_field_regions, source_region};
use super::field_targets::EnumTargets;
use super::inputs::{as_u32, damaged};
use crate::error::Result;
use crate::ffi;
use crate::format::keyword_columns::EnumColumn;

struct EnumText {
    units: Vec<u16>,
    offsets: Vec<u32>,
    suffixes: Vec<u32>,
}

fn units_at<'u>(units: &'u [u16], offsets: &[u32], at: usize) -> &'u [u16] {
    let start = offsets.get(at).copied().unwrap_or(0) as usize;
    let end = offsets.get(at + 1).copied().unwrap_or(0) as usize;
    units.get(start..end).unwrap_or(&[])
}

fn enum_text(values: &[String]) -> Result<EnumText> {
    let mut units = Vec::new();
    let mut offsets = Vec::with_capacity(values.len() + 1);
    offsets.push(0);
    for value in values {
        units.extend(value.encode_utf16());
        offsets.push(as_u32(units.len(), "enum value units")?);
    }
    let mut suffixes: Vec<u32> = (0..as_u32(values.len(), "enum values")?).collect();
    suffixes.sort_by(|&left, &right| {
        let left = units_at(&units, &offsets, left as usize);
        let right = units_at(&units, &offsets, right as usize);
        left.iter().rev().cmp(right.iter().rev())
    });
    Ok(EnumText {
        units,
        offsets,
        suffixes,
    })
}

fn merged_values(merged: &EnumTargets) -> Result<Vec<String>> {
    let count = merged.text_offsets.len().saturating_sub(1);
    (0..count)
        .map(|at| {
            String::from_utf16(units_at(&merged.units, &merged.text_offsets, at))
                .map_err(|_| damaged("holds an enum value that is not valid text"))
        })
        .collect()
}

pub(super) fn merge_enum_column<'c>(
    inputs: &'c MergeColumns<'c>,
    field: &str,
    members: &[Option<&'c EnumColumn>],
    document_count: u32,
) -> Result<EnumColumn> {
    let mut texts = Vec::with_capacity(members.len());
    for column in members {
        texts.push(match column {
            Some(column) => Some(enum_text(&column.values)?),
            None => None,
        });
    }
    let sources: Vec<ffi::narsil_field_merge_source> = inputs
        .iter()
        .zip(members.iter().zip(&texts))
        .map(|((_, input), held)| {
            let regions = match held {
                (Some(column), Some(text)) => [
                    source_region(&text.units),
                    source_region(&text.offsets),
                    source_region(&column.offsets),
                    source_region(&column.documents),
                    source_region(&text.suffixes),
                ],
                _ => [
                    source_region::<u16>(&[]),
                    source_region(&EMPTY_OFFSETS),
                    source_region(&EMPTY_OFFSETS),
                    source_region::<u32>(&[]),
                    source_region::<u32>(&[]),
                ],
            };
            field_source(input, &regions)
        })
        .collect();
    let merged: EnumTargets =
        merge_field_regions(ffi::NARSIL_MERGE_ENUM, &sources, document_count)?;
    Ok(EnumColumn {
        field: field.to_string(),
        values: merged_values(&merged)?,
        offsets: merged.posting_offsets,
        documents: merged.postings,
    })
}
