use std::cmp::Ordering;

use super::PagedSections;
use super::cache::with_page_cache;
use crate::error::{Result, load_failed};
use crate::ffi;
use crate::index::constants::PAGED_ID_START_BYTES;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const WRITE_RECORD_WORDS: usize = 2;

impl PagedSections {
    pub(crate) fn id(&self, ordinal: u32) -> Result<String> {
        let offsets = self.file.section(&self.id_offsets);
        let values = self.file.section(&self.ids);
        let request = ffi::narsil_paged_id_request {
            offsets: &offsets,
            values: &values,
            ordinal,
        };
        let sections = [&self.id_offsets, &self.ids];
        let mut capacity = PAGED_ID_START_BYTES.min(self.ids.length as usize).max(1);
        loop {
            let mut bytes = vec![0u8; capacity];
            let mut length = 0u32;
            let output = ffi::narsil_paged_id_output {
                bytes: bytes.as_mut_ptr(),
                capacity: bytes.len(),
                length: &mut length,
            };
            let status = self
                .file
                .call(&sections, |workspace, cache, fault| unsafe {
                    ffi::narsil_read_paged_id(workspace, cache, request, output, fault)
                })?;
            if status == ffi::NARSIL_NEEDS_ROOM && capacity < self.ids.length as usize {
                capacity = capacity.saturating_mul(2).min(self.ids.length as usize);
                continue;
            }
            self.file.require(&sections, status)?;
            bytes.truncate(length as usize);
            return String::from_utf8(bytes).or_else(|_| {
                load_failed(format!(
                    "The ID of document {ordinal} of \"{}\" is not valid UTF-8",
                    self.key
                ))
            });
        }
    }

    pub(crate) fn sorted_ordinal(&self, position: u32) -> Result<u32> {
        let section = self.file.section(&self.id_order);
        let request = ffi::narsil_paged_ordinal_request {
            position,
            documents: self.document_count,
        };
        let mut ordinal = 0u32;
        let status = self
            .file
            .call(&[&self.id_order], |workspace, cache, fault| unsafe {
                ffi::narsil_read_paged_ordinal(
                    workspace,
                    cache,
                    &section,
                    request,
                    &mut ordinal,
                    1,
                    fault,
                )
            })?;
        self.file.require(&[&self.id_order], status)?;
        Ok(ordinal)
    }

    fn window_of(&self, id: &str) -> (u32, u32) {
        let after = self
            .id_sample
            .partition_point(|(sampled, _)| sampled.as_bytes() <= id.as_bytes());
        let from = match after.checked_sub(1).and_then(|at| self.id_sample.get(at)) {
            Some((_, position)) => *position,
            None => 0,
        };
        let to = match self.id_sample.get(after) {
            Some((_, position)) => position.saturating_add(1),
            None => self.document_count,
        };
        (from, to.min(self.document_count))
    }

    pub(crate) fn ordinal_of(&self, id: &str) -> Result<Option<u32>> {
        if self.document_count == 0 {
            return Ok(None);
        }
        let (mut low, mut high) = self.window_of(id);
        while low < high {
            let middle = low + (high - low) / 2;
            let ordinal = self.sorted_ordinal(middle)?;
            match self.id(ordinal)?.as_bytes().cmp(id.as_bytes()) {
                Ordering::Equal => return Ok(Some(ordinal)),
                Ordering::Less => low = middle + 1,
                Ordering::Greater => high = middle,
            }
        }
        Ok(None)
    }

    pub(crate) fn removal(&self, ordinal: u32, token_count: usize) -> Result<Vec<u32>> {
        let offsets = self.file.section(&self.removal_offsets);
        let values = self.file.section(&self.removals);
        let list = ffi::narsil_paged_removal_list {
            offsets: &offsets,
            values: &values,
            ordinal,
            token_count: u32::try_from(token_count).unwrap_or(u32::MAX),
        };
        let sections = [&self.removal_offsets, &self.removals];
        let from = self
            .file
            .read_u32(&self.removal_offsets, u64::from(ordinal))?;
        let to = self
            .file
            .read_u32(&self.removal_offsets, u64::from(ordinal) + 1)?;
        if to < from || u64::from(to) * 4 > self.removals.length {
            return load_failed(format!(
                "The removal entry of document {ordinal} of \"{}\" leaves its list",
                self.key
            ));
        }
        let mut entry = vec![0u32; (to - from) as usize];
        let mut count = 0u32;
        let output = ffi::narsil_paged_removal_output {
            values: entry.as_mut_ptr(),
            capacity: entry.len(),
            count: &mut count,
        };
        let status = self
            .file
            .call(&sections, |workspace, cache, fault| unsafe {
                ffi::narsil_read_paged_removals(workspace, cache, list, output, fault)
            })?;
        self.file.require(&sections, status)?;
        entry.truncate(count as usize);
        Ok(entry)
    }

    pub(crate) fn with_removal_view<T>(
        &self,
        remove: impl FnOnce(&ffi::narsil_frozen_paged_removals) -> Result<T>,
    ) -> Result<T> {
        let offsets = self.file.section(&self.removal_offsets);
        let values = self.file.section(&self.removals);
        let mut fault = ffi::narsil_page_fault::default();
        with_page_cache(|cache| {
            remove(&ffi::narsil_frozen_paged_removals {
                cache,
                offsets: &offsets,
                values: &values,
                fault: &mut fault,
            })
        })
    }

    pub(crate) fn write_record(&self, ordinal: u32) -> Result<Option<(u64, u64)>> {
        let (Some(seq_nos), Some(terms)) = (&self.seq_nos, &self.primary_terms) else {
            return Ok(None);
        };
        let sequences = self.file.section(seq_nos);
        let primary = self.file.section(terms);
        let request = ffi::narsil_paged_write_request {
            sequences: &sequences,
            terms: &primary,
            ordinal,
        };
        let mut values = [0u64; WRITE_RECORD_WORDS];
        let output = ffi::narsil_paged_write_output {
            values: values.as_mut_ptr(),
            capacity: values.len(),
        };
        let sections = [seq_nos, terms];
        let status = self
            .file
            .call(&sections, |workspace, cache, fault| unsafe {
                ffi::narsil_read_paged_write_record(workspace, cache, request, output, fault)
            })?;
        self.file.require(&sections, status)?;
        let [seq_no, term] = values;
        if seq_no > MAX_SAFE_INTEGER || term > MAX_SAFE_INTEGER {
            return load_failed(format!(
                "A write record of document {ordinal} lies above 2^53 - 1"
            ));
        }
        Ok(Some((seq_no, term)))
    }
}
