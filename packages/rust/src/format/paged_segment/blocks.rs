use std::io::Write;

use flate2::Compression;
use flate2::write::DeflateEncoder;

use super::DOCUMENT_BLOCK_MIN_RAW_BYTES;
use crate::error::{ErrorCode, NarsilError, Result};

fn save_failed(message: &str) -> NarsilError {
    NarsilError::new(ErrorCode::PERSISTENCE_SAVE_FAILED, message.to_string())
}

fn deflated(raw: &[u8]) -> Result<Vec<u8>> {
    let mut encoder =
        DeflateEncoder::new(Vec::with_capacity(raw.len() / 2), Compression::default());
    encoder
        .write_all(raw)
        .and_then(|()| encoder.finish())
        .map_err(|error| {
            NarsilError::new(
                ErrorCode::PERSISTENCE_SAVE_FAILED,
                format!("A document block failed to compress: {error}"),
            )
        })
}

/// Gathers stored documents in ordinal order into compressed blocks of at least `DOCUMENT_BLOCK_MIN_RAW_BYTES`,
/// and lists where each block starts in the `documents` section.
#[derive(Default)]
pub(crate) struct DocumentBlocks {
    pending: Vec<u8>,
    first_ordinal: u32,
    written: u64,
    entries: Vec<u8>,
}

impl DocumentBlocks {
    /// Adds the stored bytes of the document at `ordinal`, handing the compressed bytes of each block that it
    /// closes to `write`.
    pub(crate) fn add(
        &mut self,
        ordinal: u32,
        document: &[u8],
        write: &mut dyn FnMut(&[u8]) -> Result<()>,
    ) -> Result<()> {
        if self.pending.is_empty() {
            self.first_ordinal = ordinal;
        }
        self.pending.extend_from_slice(document);
        if self.pending.len() >= DOCUMENT_BLOCK_MIN_RAW_BYTES {
            self.close(write)?;
        }
        Ok(())
    }

    fn close(&mut self, write: &mut dyn FnMut(&[u8]) -> Result<()>) -> Result<()> {
        if self.pending.is_empty() {
            return Ok(());
        }
        let compressed = deflated(&self.pending)?;
        let raw_length = u32::try_from(self.pending.len())
            .map_err(|_| save_failed("A document block holds too many bytes"))?;
        let length = u32::try_from(compressed.len())
            .map_err(|_| save_failed("A document block compresses to too many bytes"))?;
        self.entries
            .extend_from_slice(&self.first_ordinal.to_le_bytes());
        self.entries.extend_from_slice(&self.written.to_le_bytes());
        self.entries.extend_from_slice(&length.to_le_bytes());
        self.entries.extend_from_slice(&raw_length.to_le_bytes());
        write(&compressed)?;
        self.written += compressed.len() as u64;
        self.pending.clear();
        Ok(())
    }

    /// Closes the last block and returns the `documentBlocks` section that lists every block.
    pub(crate) fn finish(mut self, write: &mut dyn FnMut(&[u8]) -> Result<()>) -> Result<Vec<u8>> {
        self.close(write)?;
        Ok(self.entries)
    }
}
