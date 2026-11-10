use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use super::cache::{Cached, Kind, cached, release, remember};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::envelope::HEADER_BYTES;
use crate::format::paged_segment::head::PagedSection;
use crate::util::hash::crc32;

static NEXT_FILE_NUMBER: AtomicU64 = AtomicU64::new(1);

/// An open paged segment file that the engine reads by position, never by mapping it, so that a failed read
/// raises an error.
pub(crate) struct PagedFile {
    path: PathBuf,
    file: File,
    number: u64,
}

impl Drop for PagedFile {
    fn drop(&mut self) {
        release(self.number);
    }
}

fn unreadable(path: &Path, offset: u64) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_LOAD_FAILED,
        format!(
            "The file \"{}\" cannot be read at byte {offset}",
            path.display()
        ),
    )
}

#[cfg(unix)]
fn read_at(file: &File, offset: u64, target: &mut [u8]) -> std::io::Result<()> {
    std::os::unix::fs::FileExt::read_exact_at(file, target, offset)
}

#[cfg(windows)]
fn read_at(file: &File, mut offset: u64, mut target: &mut [u8]) -> std::io::Result<()> {
    while !target.is_empty() {
        let read = std::os::windows::fs::FileExt::seek_read(file, target, offset)?;
        if read == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        offset += read as u64;
        target = &mut target[read..];
    }
    Ok(())
}

impl PagedFile {
    pub(crate) fn open(path: &Path) -> Result<PagedFile> {
        let file = File::open(path).map_err(|error| {
            NarsilError::new(
                ErrorCode::PERSISTENCE_LOAD_FAILED,
                format!("The file \"{}\" cannot be opened: {error}", path.display()),
            )
        })?;
        Ok(PagedFile {
            path: path.to_path_buf(),
            file,
            number: NEXT_FILE_NUMBER.fetch_add(1, Ordering::Relaxed),
        })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn number(&self) -> u64 {
        self.number
    }

    pub(crate) fn length(&self) -> Result<u64> {
        self.file
            .metadata()
            .map(|metadata| metadata.len())
            .map_err(|_| unreadable(&self.path, 0))
    }

    /// Reads `target.len()` bytes at `offset` from the start of the file.
    pub(crate) fn read_into(&self, offset: u64, target: &mut [u8]) -> Result<()> {
        read_at(&self.file, offset, target).map_err(|_| unreadable(&self.path, offset))
    }

    fn require_page(&self, section: &PagedSection, page: u64, bytes: &[u8]) -> Result<()> {
        if section.checksum_of_page(page) == Some(crc32(bytes)) {
            return Ok(());
        }
        Err(NarsilError::new(
            ErrorCode::PERSISTENCE_CRC_MISMATCH,
            format!(
                "Page {page} of section \"{}\" of the file \"{}\" does not match its checksum",
                section.name,
                self.path.display()
            ),
        ))
    }

    fn page_length(section: &PagedSection, page: u64) -> usize {
        let from = page.saturating_mul(section.page_bytes);
        section.page_bytes.min(section.length.saturating_sub(from)) as usize
    }

    /// Returns one page of a section, from this thread's cache or from the file, checking its CRC-32 on every read
    /// from the file.
    fn page(&self, section: &PagedSection, page: u64) -> Result<Arc<Vec<u8>>> {
        let start = HEADER_BYTES as u64 + section.offset + page * section.page_bytes;
        if let Some(Cached::Page(bytes)) = cached(self.number, Kind::Page, start) {
            return Ok(bytes);
        }
        let mut bytes = vec![0u8; Self::page_length(section, page)];
        self.read_into(start, &mut bytes)?;
        self.require_page(section, page, &bytes)?;
        let bytes = Arc::new(bytes);
        let size = bytes.len();
        remember(
            self.number,
            Kind::Page,
            start,
            Cached::Page(Arc::clone(&bytes)),
            size,
        );
        Ok(bytes)
    }

    /// Reads `length` bytes at `position` inside `section`, one page at a time.
    pub(crate) fn read(
        &self,
        section: &PagedSection,
        position: u64,
        length: u64,
    ) -> Result<Vec<u8>> {
        let inside = position
            .checked_add(length)
            .is_some_and(|end| end <= section.length);
        if !inside {
            return Err(NarsilError::new(
                ErrorCode::PERSISTENCE_LOAD_FAILED,
                format!(
                    "A read of {length} bytes at {position} ends outside section \"{}\" of \"{}\"",
                    section.name,
                    self.path.display()
                ),
            ));
        }
        let mut out = Vec::with_capacity(length as usize);
        let mut at = position;
        let end = position + length;
        while at < end {
            let page = at / section.page_bytes;
            let from = (at - page * section.page_bytes) as usize;
            let bytes = self.page(section, page)?;
            let take = (bytes.len().saturating_sub(from) as u64).min(end - at) as usize;
            let Some(slice) = bytes
                .get(from..from + take)
                .filter(|slice| !slice.is_empty())
            else {
                return Err(unreadable(&self.path, at));
            };
            out.extend_from_slice(slice);
            at += take as u64;
        }
        Ok(out)
    }

    pub(crate) fn read_u32(&self, section: &PagedSection, index: u64) -> Result<u32> {
        let bytes = self.read(section, index.saturating_mul(4), 4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    pub(crate) fn read_u64(&self, section: &PagedSection, index: u64) -> Result<u64> {
        let bytes = self.read(section, index.saturating_mul(8), 8)?;
        let mut raw = [0u8; 8];
        raw.copy_from_slice(&bytes);
        Ok(u64::from_le_bytes(raw))
    }

    /// Reads a whole section past the cache and checks the CRC-32 of each of its pages.
    pub(crate) fn whole_checked(&self, section: &PagedSection) -> Result<Vec<u8>> {
        let mut bytes = vec![0u8; section.length as usize];
        if !bytes.is_empty() {
            self.read_into(HEADER_BYTES as u64 + section.offset, &mut bytes)?;
        }
        for (page, chunk) in bytes.chunks(section.page_bytes as usize).enumerate() {
            self.require_page(section, page as u64, chunk)?;
        }
        Ok(bytes)
    }
}
