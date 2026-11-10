use std::sync::Arc;

use super::PagedSections;
use super::cache::{Cached, Kind, cached, remember};
use crate::error::{Result, load_failed};
use crate::format::paged_segment::POSTING_WIDTH_BYTES;

const POSITION_WIDTH_BYTES: u64 = 4;

/// The postings of one token of a paged segment, ascending by document and then by field.
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

/// The positions of each posting of one token of a paged segment, with offsets counted from the token's first.
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
    bytes
        .chunks_exact(4)
        .map(|chunk| u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
}

fn u16s(bytes: &[u8]) -> impl Iterator<Item = u16> + '_ {
    bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
}

impl PagedSections {
    fn require_list_rules(&self, list: &PostingList, token: usize) -> Result<()> {
        let key = &self.key;
        for row in 0..list.len() {
            let document = list.documents[row];
            let field = list.fields[row];
            if document >= self.document_count {
                return load_failed(format!(
                    "Token {token} of \"{key}\" names document {document} of {}",
                    self.document_count
                ));
            }
            if field as usize >= self.field_count {
                return load_failed(format!(
                    "Token {token} of \"{key}\" names field {field} of {}",
                    self.field_count
                ));
            }
            if row > 0 {
                let before = list.documents[row - 1];
                if document < before || (document == before && field <= list.fields[row - 1]) {
                    return load_failed(format!(
                        "The list of token {token} of \"{key}\" descends at posting {row}"
                    ));
                }
            }
        }
        Ok(())
    }

    /// Returns the postings of the token at `token`, whose list starts at posting `start` and holds `count`,
    /// reading only the pages that hold them and checking every value before a search uses it.
    pub(crate) fn list(&self, token: usize, start: u32, count: u32) -> Result<Arc<PostingList>> {
        if let Some(Cached::List(list)) = cached(self.file.number(), Kind::List, token as u64) {
            return Ok(list);
        }
        let bytes = self.file.read(
            &self.postings,
            u64::from(start) * POSTING_WIDTH_BYTES,
            u64::from(count) * POSTING_WIDTH_BYTES,
        )?;
        let count = count as usize;
        let (documents, rest) = bytes.split_at(count * 4);
        let (frequencies, fields) = rest.split_at(count * 2);
        let list = PostingList {
            documents: u32s(documents).collect(),
            frequencies: u16s(frequencies).collect(),
            fields: u16s(fields).collect(),
        };
        self.require_list_rules(&list, token)?;
        let list = Arc::new(list);
        remember(
            self.file.number(),
            Kind::List,
            token as u64,
            Cached::List(Arc::clone(&list)),
            bytes.len(),
        );
        Ok(list)
    }

    /// Returns the positions of every posting of the token at `token`, or `None` where the segment tracks none.
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
        let offset_bytes = self.file.read(
            offsets_section,
            u64::from(start) * POSITION_WIDTH_BYTES,
            (u64::from(count) + 1) * POSITION_WIDTH_BYTES,
        )?;
        let absolute: Vec<u32> = u32s(&offset_bytes).collect();
        let first = absolute.first().copied().unwrap_or(0);
        let end = absolute.last().copied().unwrap_or(0);
        let mut offsets = Vec::with_capacity(absolute.len());
        for (row, &value) in absolute.iter().enumerate() {
            if value < first || value > end || (row > 0 && value < absolute[row - 1]) {
                return load_failed(format!(
                    "The position offsets of token {token} of \"{}\" leave their list",
                    self.key
                ));
            }
            offsets.push(value - first);
        }
        let value_bytes = self.file.read(
            values_section,
            u64::from(first) * POSITION_WIDTH_BYTES,
            u64::from(end - first) * POSITION_WIDTH_BYTES,
        )?;
        let loaded = Arc::new(PostingPositions {
            offsets,
            values: u32s(&value_bytes).collect(),
        });
        remember(
            self.file.number(),
            Kind::Positions,
            token as u64,
            Cached::Positions(Arc::clone(&loaded)),
            offset_bytes.len() + value_bytes.len(),
        );
        Ok(Some(loaded))
    }

    /// Returns the summed term frequency of the stored postings of the token at `token`.
    pub(crate) fn total(&self, token: usize) -> Result<f64> {
        let Some(totals) = &self.token_totals else {
            return load_failed(format!(
                "The segment \"{}\" holds no token totals",
                self.key
            ));
        };
        let bits = self.file.read_u64(totals, token as u64)?;
        Ok(f64::from_bits(bits))
    }

    pub(crate) fn tracks_positions(&self) -> bool {
        self.position_offsets.is_some()
    }
}
