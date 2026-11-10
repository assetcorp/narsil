use std::collections::HashSet;
use std::ptr;

use super::inputs::{MergeInput, as_u32, damaged, field_names_of, too_large};
use super::sources::{MergeSources, PairTable};
use crate::error::Result;
use crate::ffi;
use crate::format::keyword_columns::{FieldLengthColumn, SurfaceForms};
use crate::format::keyword_segment::Positions;
use crate::index::segment::SegmentData;
use crate::keyword::workspace::{core_refused, with_workspace};

#[derive(Default)]
pub(crate) struct MergedPostings {
    pub(crate) tokens: Vec<u8>,
    pub(crate) token_offsets: Vec<u32>,
    pub(crate) document_frequencies: Vec<u32>,
    pub(crate) posting_offsets: Vec<u32>,
    pub(crate) posting_documents: Vec<u32>,
    pub(crate) posting_frequencies: Vec<u16>,
    pub(crate) posting_fields: Vec<u16>,
    pub(crate) positions: Option<Positions>,
}

impl MergedPostings {
    pub(crate) fn token_index(&self, token: &[u8]) -> Option<u32> {
        let count = self.token_offsets.len().saturating_sub(1);
        let mut low = 0usize;
        let mut high = count;
        while low < high {
            let middle = low + (high - low) / 2;
            let start = self.token_offsets.get(middle).copied().unwrap_or(0) as usize;
            let end = self.token_offsets.get(middle + 1).copied().unwrap_or(0) as usize;
            let held = self.tokens.get(start..end).unwrap_or(&[]);
            match held.cmp(token) {
                std::cmp::Ordering::Less => low = middle + 1,
                std::cmp::Ordering::Greater => high = middle,
                std::cmp::Ordering::Equal => return u32::try_from(middle).ok(),
            }
        }
        None
    }
}

pub(crate) struct MergedKeywords {
    pub(crate) postings: MergedPostings,
    pub(crate) field_lengths: Vec<FieldLengthColumn>,
    pub(crate) surface_forms: Option<SurfaceForms>,
    pub(super) spellings: PairTable,
}

pub(super) struct MergeOutput {
    terms: PairTable,
    posting_offsets: Vec<u32>,
    posting_documents: Vec<u32>,
    posting_frequencies: Vec<u16>,
    posting_fields: Vec<u16>,
    position_offsets: Vec<u32>,
    position_values: Vec<u32>,
    pub(super) field_lengths: Vec<u32>,
    total_field_lengths: Vec<f64>,
    pub(super) surfaces: PairTable,
    pub(super) spellings: PairTable,
    has_positions: bool,
}

fn strings(count: u32, bytes: u32, stride: usize) -> PairTable {
    PairTable {
        text: vec![0; bytes as usize],
        offsets: vec![0; count as usize * stride + 1],
        counts: vec![0; count as usize],
    }
}

fn merged_strings(table: &mut PairTable) -> ffi::narsil_merged_strings {
    ffi::narsil_merged_strings {
        text: table.text.as_mut_ptr(),
        offsets: table.offsets.as_mut_ptr(),
        counts: table.counts.as_mut_ptr(),
        count_capacity: table.counts.len(),
        text_capacity: table.text.len(),
        offset_capacity: table.offsets.len(),
    }
}

impl MergeOutput {
    fn sized(
        sizes: &ffi::narsil_keyword_merge_sizes,
        documents: u32,
        fields: usize,
    ) -> MergeOutput {
        let postings = sizes.postings as usize;
        let positions = sizes.has_positions != 0;
        MergeOutput {
            terms: strings(sizes.terms, sizes.term_bytes, 1),
            posting_offsets: vec![0; sizes.terms as usize + 1],
            posting_documents: vec![0; postings],
            posting_frequencies: vec![0; postings],
            posting_fields: vec![0; postings],
            position_offsets: if positions {
                vec![0; postings + 1]
            } else {
                Vec::new()
            },
            position_values: if positions {
                vec![0; sizes.positions as usize]
            } else {
                Vec::new()
            },
            field_lengths: vec![0; documents as usize * fields],
            total_field_lengths: vec![0.0; fields],
            surfaces: strings(sizes.surfaces, sizes.surface_bytes, 2),
            spellings: strings(sizes.spellings, sizes.spelling_bytes, 2),
            has_positions: false,
        }
    }

    fn raw(&mut self, positions: bool) -> ffi::narsil_keyword_merge_output {
        ffi::narsil_keyword_merge_output {
            terms: merged_strings(&mut self.terms),
            posting_offsets: self.posting_offsets.as_mut_ptr(),
            posting_offset_capacity: self.posting_offsets.len(),
            posting_documents: self.posting_documents.as_mut_ptr(),
            posting_frequencies: self.posting_frequencies.as_mut_ptr(),
            posting_fields: self.posting_fields.as_mut_ptr(),
            posting_capacity: self.posting_documents.len(),
            position_offsets: match positions {
                true => self.position_offsets.as_mut_ptr(),
                false => ptr::null_mut(),
            },
            position_offset_capacity: self.position_offsets.len(),
            position_values: match positions {
                true => self.position_values.as_mut_ptr(),
                false => ptr::null_mut(),
            },
            position_capacity: self.position_values.len(),
            field_lengths: self.field_lengths.as_mut_ptr(),
            field_length_capacity: self.field_lengths.len(),
            total_field_lengths: self.total_field_lengths.as_mut_ptr(),
            field_count: self.total_field_lengths.len(),
            surfaces: merged_strings(&mut self.surfaces),
            spellings: merged_strings(&mut self.spellings),
        }
    }
}

fn refused(status: ffi::narsil_status) -> crate::error::NarsilError {
    match status {
        ffi::NARSIL_SEGMENT_FULL => too_large("surface or spelling occurrences"),
        status => core_refused("a keyword merge", status),
    }
}

fn length_names<'a>(inputs: &[MergeInput<'a>]) -> Vec<&'a str> {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut names = Vec::new();
    for input in inputs {
        let held: Vec<&str> = match &input.entry.data {
            SegmentData::Frozen(segment) => segment
                .payload
                .field_lengths
                .iter()
                .map(|column| column.field.as_str())
                .collect(),
            SegmentData::Tail(_) => field_names_of(input.entry)
                .iter()
                .map(String::as_str)
                .collect(),
        };
        for name in held {
            if seen.insert(name) {
                names.push(name);
            }
        }
    }
    names
}

fn length_columns(
    inputs: &[MergeInput<'_>],
    field_names: &[String],
    output: &MergeOutput,
    documents: usize,
) -> Result<Vec<FieldLengthColumn>> {
    let mut columns = Vec::new();
    for name in length_names(inputs) {
        let Some(field) = field_names.iter().position(|held| held == name) else {
            return Err(damaged(
                "lists a field length column outside its field names",
            ));
        };
        let lengths = output
            .field_lengths
            .get(field * documents..(field + 1) * documents)
            .unwrap_or(&[])
            .to_vec();
        columns.push(FieldLengthColumn {
            field: name.to_string(),
            lengths,
        });
    }
    Ok(columns)
}

pub(super) fn run_merge(
    inputs: &[ffi::narsil_keyword_merge_input],
    document_count: u32,
    field_count: usize,
    retained: Option<&ffi::narsil_frozen_strings>,
) -> Result<MergeOutput> {
    let request = ffi::narsil_keyword_merge_request {
        inputs: inputs.as_ptr(),
        input_count: inputs.len(),
        document_count,
        field_count: as_u32(field_count, "field names")?,
        retained_terms: retained.map_or(ptr::null(), |table| table as *const _),
    };
    let mut sizes = ffi::narsil_keyword_merge_sizes::default();
    let measured = with_workspace(|workspace| {
        Ok(unsafe { ffi::narsil_measure_merge(workspace, &request, &mut sizes) })
    })?;
    if measured != ffi::NARSIL_OK {
        return Err(refused(measured));
    }
    let positions = sizes.has_positions != 0;
    let mut output = MergeOutput::sized(&sizes, document_count, field_count);
    let raw = output.raw(positions);
    let written = with_workspace(|workspace| {
        Ok(unsafe { ffi::narsil_write_merge(workspace, &request, &raw) })
    })?;
    if written != ffi::NARSIL_OK {
        return Err(refused(written));
    }
    output.has_positions = positions;
    Ok(output)
}

pub(super) fn surface_forms_of(table: &mut PairTable) -> Option<SurfaceForms> {
    (!table.counts.is_empty()).then(|| SurfaceForms {
        text: std::mem::take(&mut table.text),
        offsets: std::mem::take(&mut table.offsets),
        counts: std::mem::take(&mut table.counts),
    })
}

pub(crate) fn merge_keywords(
    inputs: &[MergeInput<'_>],
    document_count: u32,
    field_names: &[String],
) -> Result<MergedKeywords> {
    let sources = MergeSources::of(inputs)?;
    let mut output = run_merge(&sources.inputs, document_count, field_names.len(), None)?;
    let positions = output.has_positions;
    let field_lengths = length_columns(inputs, field_names, &output, document_count as usize)?;
    let surface_forms = surface_forms_of(&mut output.surfaces);
    let postings = MergedPostings {
        tokens: output.terms.text,
        token_offsets: output.terms.offsets,
        document_frequencies: output.terms.counts,
        posting_offsets: output.posting_offsets,
        posting_documents: output.posting_documents,
        posting_frequencies: output.posting_frequencies,
        posting_fields: output.posting_fields,
        positions: positions.then_some(Positions {
            offsets: output.position_offsets,
            values: output.position_values,
        }),
    };
    Ok(MergedKeywords {
        postings,
        field_lengths,
        surface_forms,
        spellings: output.spellings,
    })
}
