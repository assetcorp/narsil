use std::sync::Arc;

use super::PagedSections;
use super::cache::{Cached, Kind, cached, remember};
use crate::error::{Result, load_failed};
use crate::ffi;
use crate::format::paged_segment::POSTING_WIDTH_BYTES;
use crate::util::bytes::le_values;

#[derive(Debug, Default)]
pub(crate) struct PostingList {
    pub(crate) documents: Vec<u32>,
    pub(crate) frequencies: Vec<u16>,
    pub(crate) fields: Vec<u16>,
}

impl PostingList {
    pub(crate) fn len(&self) -> usize {
        self.documents.len()
    }
}

#[derive(Debug, Default)]
pub(crate) struct PostingPositions {
    pub(crate) offsets: Vec<u32>,
    pub(crate) values: Vec<u32>,
}

impl PostingPositions {
    pub(crate) fn of(&self, row: usize) -> &[u32] {
        let start = self.offsets.get(row).copied().unwrap_or(0) as usize;
        let end = self.offsets.get(row + 1).copied().unwrap_or(0) as usize;
        self.values.get(start..end).unwrap_or(&[])
    }
}

fn u32s(bytes: &[u8]) -> impl Iterator<Item = u32> + '_ {
    le_values(bytes, u32::from_le_bytes)
}

fn u16s(bytes: &[u8]) -> impl Iterator<Item = u16> + '_ {
    le_values(bytes, u16::from_le_bytes)
}

impl PagedSections {
    pub(crate) fn list(&self, token: usize, start: u32, count: u32) -> Result<Arc<PostingList>> {
        if let Some(Cached::List(list)) = cached(self.file.number(), Kind::List, token as u64) {
            return Ok(list);
        }
        let held = self.postings.length / POSTING_WIDTH_BYTES;
        if u64::from(start) + u64::from(count) > held {
            return load_failed(format!(
                "The postings of token {token} of \"{}\" leave their section",
                self.key
            ));
        }
        let mut bytes = vec![0u8; count as usize * POSTING_WIDTH_BYTES as usize];
        let section = self.file.section(&self.postings);
        let request = ffi::narsil_paged_posting_list {
            first: start,
            count,
            documents: self.document_count,
            fields: u32::try_from(self.field_count).unwrap_or(u32::MAX),
        };
        let status = self
            .file
            .call(&[&self.postings], |workspace, cache, fault| unsafe {
                ffi::narsil_read_paged_postings(
                    workspace,
                    cache,
                    &section,
                    request,
                    bytes.as_mut_ptr(),
                    bytes.len(),
                    fault,
                )
            })?;
        self.file.require(&[&self.postings], status)?;
        let count = count as usize;
        let (documents, rest) = bytes.split_at(count * 4);
        let (frequencies, fields) = rest.split_at(count * 2);
        let list = Arc::new(PostingList {
            documents: u32s(documents).collect(),
            frequencies: u16s(frequencies).collect(),
            fields: u16s(fields).collect(),
        });
        remember(
            self.file.number(),
            Kind::List,
            token as u64,
            Cached::List(Arc::clone(&list)),
            bytes.len(),
        );
        Ok(list)
    }

    pub(crate) fn positions(
        &self,
        token: usize,
        start: u32,
        count: u32,
    ) -> Result<Option<Arc<PostingPositions>>> {
        let (Some(offsets_section), Some(values_section)) =
            (&self.position_offsets, &self.positions)
        else {
            return Ok(None);
        };
        if let Some(Cached::Positions(held)) =
            cached(self.file.number(), Kind::Positions, token as u64)
        {
            return Ok(Some(held));
        }
        let first = self.file.read_u32(offsets_section, u64::from(start))?;
        let end = self
            .file
            .read_u32(offsets_section, u64::from(start) + u64::from(count))?;
        if end < first || u64::from(end) * 4 > values_section.length {
            return load_failed(format!(
                "The positions of token {token} of \"{}\" leave their section",
                self.key
            ));
        }
        let mut offsets = vec![0u32; count as usize + 1];
        let mut values = vec![0u32; (end - first) as usize];
        let offsets_raw = self.file.section(offsets_section);
        let values_raw = self.file.section(values_section);
        let list = ffi::narsil_paged_position_list {
            offsets: &offsets_raw,
            values: &values_raw,
            first: start,
            count,
        };
        let output = ffi::narsil_paged_position_output {
            offsets: offsets.as_mut_ptr(),
            offset_capacity: offsets.len(),
            values: values.as_mut_ptr(),
            value_capacity: values.len(),
        };
        let sections = [offsets_section, values_section];
        let status = self
            .file
            .call(&sections, |workspace, cache, fault| unsafe {
                ffi::narsil_read_paged_positions(workspace, cache, list, output, fault)
            })?;
        self.file.require(&sections, status)?;
        let bytes = (offsets.len() + values.len()) * 4;
        let loaded = Arc::new(PostingPositions { offsets, values });
        remember(
            self.file.number(),
            Kind::Positions,
            token as u64,
            Cached::Positions(Arc::clone(&loaded)),
            bytes,
        );
        Ok(Some(loaded))
    }

    pub(crate) fn totals(&self, first: u32, output: &mut [f64]) -> Result<()> {
        let Some(totals) = &self.token_totals else {
            return load_failed(format!(
                "The segment \"{}\" holds no token totals",
                self.key
            ));
        };
        let section = self.file.section(totals);
        let request = ffi::narsil_paged_totals_request {
            first,
            count: u32::try_from(output.len()).unwrap_or(u32::MAX),
        };
        let status = self
            .file
            .call(&[totals], |workspace, cache, fault| unsafe {
                ffi::narsil_read_paged_totals(
                    workspace,
                    cache,
                    &section,
                    request,
                    output.as_mut_ptr(),
                    output.len(),
                    fault,
                )
            })?;
        self.file.require(&[totals], status)
    }

    pub(crate) fn tracks_positions(&self) -> bool {
        self.position_offsets.is_some()
    }
}
