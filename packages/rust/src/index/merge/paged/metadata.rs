use std::collections::HashMap;

use super::super::inputs::{MergeInput, too_large};
use super::super::keywords::{run_merge, surface_forms_of};
use super::super::sources::{MergeSources, PairTable, bare_input, full_column, strip_postings};
use super::lists::frozen_of;
use crate::error::Result;
use crate::ffi;
use crate::format::keyword_columns::{FieldLengthColumn, SurfaceForms};

pub(super) struct PagedStrings {
    pub(super) surface_forms: Option<SurfaceForms>,
    pub(super) spellings: PairTable,
}

pub(super) fn merge_paged_lengths(
    inputs: &[MergeInput<'_>],
    document_count: u32,
) -> Result<Vec<FieldLengthColumn>> {
    let mut names: Vec<String> = Vec::new();
    let mut slots: HashMap<String, u16> = HashMap::new();
    let mut mappings: Vec<Vec<u16>> = Vec::with_capacity(inputs.len());
    let mut columns: Vec<Vec<*const u32>> = Vec::with_capacity(inputs.len());
    for input in inputs {
        let segment = frozen_of(input)?;
        let mut mapping = Vec::with_capacity(segment.payload.field_lengths.len());
        let mut pointers = Vec::with_capacity(segment.payload.field_lengths.len());
        for column in &segment.payload.field_lengths {
            let at = match slots.get(&column.field) {
                Some(&at) => at,
                None => {
                    let at = u16::try_from(names.len()).map_err(|_| too_large("field names"))?;
                    names.push(column.field.clone());
                    slots.insert(column.field.clone(), at);
                    at
                }
            };
            mapping.push(at);
            pointers.push(full_column(&column.lengths, input.remap.len())?);
        }
        mappings.push(mapping);
        columns.push(pointers);
    }
    let mut raw = Vec::with_capacity(inputs.len());
    for ((input, mapping), pointers) in inputs.iter().zip(&mappings).zip(&columns) {
        let mut source = bare_input(input);
        source.field_mapping = mapping.as_ptr();
        source.field_count = mapping.len() as u32;
        source.field_lengths = pointers.as_ptr();
        raw.push(source);
    }
    let output = run_merge(&raw, document_count, names.len(), None)?;
    let documents = document_count as usize;
    Ok(names
        .into_iter()
        .enumerate()
        .map(|(field, name)| FieldLengthColumn {
            field: name,
            lengths: output
                .field_lengths
                .get(field * documents..(field + 1) * documents)
                .unwrap_or(&[])
                .to_vec(),
        })
        .collect())
}

pub(super) fn merge_paged_strings(
    inputs: &[MergeInput<'_>],
    document_count: u32,
    tokens: &[u8],
    token_offsets: &[u32],
    document_frequencies: &[u32],
) -> Result<PagedStrings> {
    let mut sources = MergeSources::of(inputs)?;
    for raw in &mut sources.inputs {
        strip_postings(raw);
    }
    let retained = ffi::narsil_frozen_strings {
        text: tokens.as_ptr(),
        text_bytes: tokens.len(),
        offsets: token_offsets.as_ptr(),
        counts: document_frequencies.as_ptr(),
        count: document_frequencies.len(),
    };
    let mut output = run_merge(&sources.inputs, document_count, 0, Some(&retained))?;
    let surface_forms = surface_forms_of(&mut output.surfaces);
    Ok(PagedStrings {
        surface_forms,
        spellings: output.spellings,
    })
}
