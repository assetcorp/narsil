use std::cmp::Ordering;

use super::PagedSections;
use crate::error::{Result, load_failed};

impl PagedSections {
    /// Returns the ID of the document at `ordinal`, reading the pages of `idOffsets` and `ids` that hold it.
    pub(crate) fn id(&self, ordinal: u32) -> Result<String> {
        let from = self.file.read_u32(&self.id_offsets, u64::from(ordinal))?;
        let to = self
            .file
            .read_u32(&self.id_offsets, u64::from(ordinal) + 1)?;
        if to < from || u64::from(to) > self.ids.length {
            return load_failed(format!(
                "The ID of document {ordinal} of \"{}\" leaves its list",
                self.key
            ));
        }
        let bytes = self
            .file
            .read(&self.ids, u64::from(from), u64::from(to - from))?;
        String::from_utf8(bytes).or_else(|_| {
            load_failed(format!(
                "The ID of document {ordinal} of \"{}\" is not valid UTF-8",
                self.key
            ))
        })
    }

    /// Returns the ordinal at `position` of the segment's ascending ID order.
    pub(crate) fn sorted_ordinal(&self, position: u32) -> Result<u32> {
        let ordinal = self.file.read_u32(&self.id_order, u64::from(position))?;
        if ordinal >= self.document_count {
            return load_failed(format!(
                "idOrder of \"{}\" names document {ordinal} of {}",
                self.key, self.document_count
            ));
        }
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

    /// Returns the ordinal of the document whose ID is `id`, searching the window of `idOrder` that the ID sample
    /// gives it, or `None` where the segment holds no such document.
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

    /// Returns the token and the summed term frequency of every token that the document at `ordinal` holds, in
    /// ascending token order, as its removal entry lists them.
    pub(crate) fn removal(&self, ordinal: u32, token_count: usize) -> Result<Vec<(u32, u32)>> {
        let from = self
            .file
            .read_u32(&self.removal_offsets, u64::from(ordinal))?;
        let to = self
            .file
            .read_u32(&self.removal_offsets, u64::from(ordinal) + 1)?;
        if to < from || u64::from(to) * 4 > self.removals.length || from % 2 != 0 || to % 2 != 0 {
            return load_failed(format!(
                "The removal entry of document {ordinal} of \"{}\" leaves its list",
                self.key
            ));
        }
        let bytes = self.file.read(
            &self.removals,
            u64::from(from) * 4,
            u64::from(to - from) * 4,
        )?;
        let mut entries = Vec::with_capacity(bytes.len() / 8);
        for pair in bytes.chunks_exact(8) {
            let token = u32::from_le_bytes([pair[0], pair[1], pair[2], pair[3]]);
            let occurrences = u32::from_le_bytes([pair[4], pair[5], pair[6], pair[7]]);
            if token as usize >= token_count {
                return load_failed(format!(
                    "The removal entry of document {ordinal} of \"{}\" names token {token}",
                    self.key
                ));
            }
            entries.push((token, occurrences));
        }
        Ok(entries)
    }

    /// Returns the `seqNo` and `primaryTerm` of the document at `ordinal`, or `None` where the segment keeps no
    /// write records.
    pub(crate) fn write_record(&self, ordinal: u32) -> Result<Option<(u64, u64)>> {
        let (Some(seq_nos), Some(terms)) = (&self.seq_nos, &self.primary_terms) else {
            return Ok(None);
        };
        let seq_no = self.file.read_u64(seq_nos, u64::from(ordinal))?;
        let term = self.file.read_u64(terms, u64::from(ordinal))?;
        if seq_no > MAX_SAFE_INTEGER || term > MAX_SAFE_INTEGER {
            return load_failed(format!(
                "A write record of document {ordinal} lies above 2^53 - 1"
            ));
        }
        Ok(Some((seq_no, term)))
    }
}

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
