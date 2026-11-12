use std::sync::Arc;

use flate2::{Decompress, FlushDecompress, Status};

use super::PagedSections;
use super::cache::{Cached, Kind, cached, remember};
use crate::error::{Result, load_failed};
use crate::format::paged_segment::MAX_DOCUMENT_BLOCK_RAW_BYTES;
use crate::value::Decoder;

/// Where one compressed block of documents starts in the `documents` section, and the first ordinal it holds.
#[derive(Debug, Clone, Copy)]
pub(crate) struct BlockEntry {
    pub(crate) first_ordinal: u32,
    pub(crate) offset: u64,
    pub(crate) length: u32,
    pub(crate) raw_length: u32,
}

/// One block of documents once decompressed, with the byte where each of its documents starts.
pub(crate) struct DocumentBlock {
    bytes: Vec<u8>,
    starts: Vec<u32>,
}

fn inflated(compressed: &[u8], raw_length: u32) -> std::result::Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(raw_length as usize);
    let mut inflater = Decompress::new(false);
    let status = inflater
        .decompress_vec(compressed, &mut out, FlushDecompress::Finish)
        .map_err(|error| error.to_string())?;
    if status != Status::StreamEnd && out.len() == raw_length as usize {
        let mut probe = Vec::with_capacity(1);
        let consumed = inflater.total_in() as usize;
        let rest = compressed.get(consumed..).unwrap_or(&[]);
        inflater
            .decompress_vec(rest, &mut probe, FlushDecompress::Finish)
            .map_err(|error| error.to_string())?;
        if !probe.is_empty() {
            return Ok([out, probe].concat());
        }
    }
    if status != Status::StreamEnd && out.len() < raw_length as usize {
        return Err("the stream ends early".to_string());
    }
    Ok(out)
}

impl PagedSections {
    fn block_of(&self, ordinal: u32) -> usize {
        self.document_blocks
            .partition_point(|block| block.first_ordinal <= ordinal)
            .saturating_sub(1)
    }

    fn block_end(&self, block: usize) -> u32 {
        self.document_blocks
            .get(block + 1)
            .map_or(self.document_count, |next| next.first_ordinal)
    }

    fn inflate(&self, block: usize, entry: &BlockEntry) -> Result<Vec<u8>> {
        let key = &self.key;
        if entry.raw_length > MAX_DOCUMENT_BLOCK_RAW_BYTES {
            return load_failed(format!(
                "Document block {block} of \"{key}\" claims {} bytes",
                entry.raw_length
            ));
        }
        let compressed = self
            .file
            .read(&self.documents, entry.offset, u64::from(entry.length))?;
        let raw = match inflated(&compressed, entry.raw_length) {
            Ok(raw) => raw,
            Err(message) => {
                return load_failed(format!(
                    "Document block {block} of \"{key}\" fails to inflate: {message}"
                ));
            }
        };
        if raw.len() != entry.raw_length as usize {
            return load_failed(format!(
                "Document block {block} of \"{key}\" inflates to {} bytes of {}",
                raw.len(),
                entry.raw_length
            ));
        }
        Ok(raw)
    }

    fn starts_of(&self, block: usize, first: u32, bytes: &[u8]) -> Result<Vec<u32>> {
        let key = &self.key;
        let count = self.block_end(block).saturating_sub(first) as usize;
        let mut starts = Vec::with_capacity(count.min(bytes.len()) + 1);
        let mut cursor = 0usize;
        for at in 0..count {
            starts.push(cursor as u32);
            let mut decoder = Decoder::new(bytes.get(cursor..).unwrap_or(&[]));
            if cursor >= bytes.len() || decoder.skip().is_err() {
                return load_failed(format!(
                    "Document block {block} of \"{key}\" holds a broken document at {at}"
                ));
            }
            cursor += decoder.position();
        }
        starts.push(cursor as u32);
        if cursor != bytes.len() {
            return load_failed(format!(
                "Document block {block} of \"{key}\" holds bytes past its documents"
            ));
        }
        Ok(starts)
    }

    fn load_block(&self, block: usize) -> Result<Arc<DocumentBlock>> {
        if let Some(Cached::Block(held)) = cached(self.file.number(), Kind::Block, block as u64) {
            return Ok(held);
        }
        let Some(entry) = self.document_blocks.get(block).copied() else {
            return load_failed(format!(
                "The segment \"{}\" holds no document block {block}",
                self.key
            ));
        };
        let bytes = self.inflate(block, &entry)?;
        let starts = self.starts_of(block, entry.first_ordinal, &bytes)?;
        let size = bytes.len() + starts.len() * 4;
        let loaded = Arc::new(DocumentBlock { bytes, starts });
        remember(
            self.file.number(),
            Kind::Block,
            block as u64,
            Cached::Block(Arc::clone(&loaded)),
            size,
        );
        Ok(loaded)
    }

    /// Returns the stored bytes of the document at `ordinal`, decompressing the block that holds it.
    pub(crate) fn document_bytes(&self, ordinal: u32) -> Result<Vec<u8>> {
        if ordinal >= self.document_count {
            return load_failed(format!(
                "Document {ordinal} lies outside \"{}\", which holds {}",
                self.key, self.document_count
            ));
        }
        let block = self.block_of(ordinal);
        let loaded = self.load_block(block)?;
        let first = self
            .document_blocks
            .get(block)
            .map_or(0, |entry| entry.first_ordinal);
        let row = (ordinal - first) as usize;
        let start = loaded.starts.get(row).copied().unwrap_or(0) as usize;
        let end = loaded.starts.get(row + 1).copied().unwrap_or(0) as usize;
        Ok(loaded.bytes.get(start..end).unwrap_or(&[]).to_vec())
    }
}
