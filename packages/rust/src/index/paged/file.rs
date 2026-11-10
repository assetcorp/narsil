use std::ffi::CString;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use super::cache::{Cached, Kind, cached, release, remember, with_page_cache};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::ffi;
use crate::format::envelope::HEADER_BYTES;
use crate::format::paged_segment::head::PagedSection;
use crate::keyword::workspace::{core_refused, with_workspace};

static NEXT_FILE_NUMBER: AtomicU64 = AtomicU64::new(1);

struct NativeFile(*mut ffi::narsil_paged_file);

unsafe impl Send for NativeFile {}
unsafe impl Sync for NativeFile {}

impl Drop for NativeFile {
    fn drop(&mut self) {
        unsafe { ffi::narsil_paged_file_close(self.0) }
    }
}

pub(crate) struct PagedFile {
    path: PathBuf,
    file: File,
    number: u64,
    native: NativeFile,
}

impl Drop for PagedFile {
    fn drop(&mut self) {
        release(self.number, self.identity());
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

fn unopened(path: &Path, reason: impl std::fmt::Display) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_LOAD_FAILED,
        format!("The file \"{}\" cannot be opened: {reason}", path.display()),
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

fn page_length(section: &PagedSection, page: u64) -> usize {
    let from = page.saturating_mul(section.page_bytes);
    section.page_bytes.min(section.length.saturating_sub(from)) as usize
}

pub(crate) fn paged_read(
    read: impl FnOnce(
        *mut ffi::narsil_workspace,
        *mut ffi::narsil_page_cache,
        *mut ffi::narsil_page_fault,
    ) -> ffi::narsil_status,
) -> Result<(ffi::narsil_status, ffi::narsil_page_fault)> {
    let mut fault = ffi::narsil_page_fault::default();
    let status = with_page_cache(|cache| {
        with_workspace(|workspace| Ok(read(workspace, cache, &mut fault)))
    })?;
    Ok((status, fault))
}

impl PagedFile {
    pub(crate) fn open(path: &Path) -> Result<PagedFile> {
        let file = File::open(path).map_err(|error| unopened(path, error))?;
        let text = path
            .to_str()
            .ok_or_else(|| unopened(path, "its path is not valid UTF-8"))?;
        let text = CString::new(text).map_err(|_| unopened(path, "its path holds a NUL byte"))?;
        let mut handle = ptr::null_mut();
        let status = unsafe { ffi::narsil_paged_file_open(text.as_ptr(), &mut handle) };
        if status != ffi::NARSIL_OK || handle.is_null() {
            return Err(unopened(path, format!("the core returned status {status}")));
        }
        Ok(PagedFile {
            path: path.to_path_buf(),
            file,
            number: NEXT_FILE_NUMBER.fetch_add(1, Ordering::Relaxed),
            native: NativeFile(handle),
        })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn number(&self) -> u64 {
        self.number
    }

    pub(crate) fn identity(&self) -> u64 {
        unsafe { ffi::narsil_paged_file_identity(self.native.0) }
    }

    pub(crate) fn length(&self) -> Result<u64> {
        Ok(unsafe { ffi::narsil_paged_file_length(self.native.0) })
    }

    pub(crate) fn read_into(&self, offset: u64, target: &mut [u8]) -> Result<()> {
        read_at(&self.file, offset, target).map_err(|_| unreadable(&self.path, offset))
    }

    pub(crate) fn section(&self, section: &PagedSection) -> ffi::narsil_page_section {
        ffi::narsil_page_section {
            file: self.native.0,
            offset: HEADER_BYTES as u64 + section.offset,
            length: section.length,
            page_bytes: u32::try_from(section.page_bytes).unwrap_or(u32::MAX),
            checksums: section.checksums.as_ptr(),
            checksum_bytes: section.checksums.len(),
        }
    }

    pub(crate) fn page_failed(
        &self,
        status: ffi::narsil_status,
        fault: &ffi::narsil_page_fault,
        sections: &[&PagedSection],
    ) -> NarsilError {
        let name = sections
            .iter()
            .find(|section| HEADER_BYTES as u64 + section.offset == fault.section)
            .or(sections.first())
            .map_or("", |section| section.name.as_str());
        let path = self.path.display();
        let page = fault.page;
        match status {
            ffi::NARSIL_PAGE_CORRUPT => NarsilError::new(
                ErrorCode::PERSISTENCE_CRC_MISMATCH,
                format!(
                    "Page {page} of section \"{name}\" of the file \"{path}\" does not match its checksum"
                ),
            ),
            ffi::NARSIL_PAGE_UNREADABLE => NarsilError::new(
                ErrorCode::PERSISTENCE_LOAD_FAILED,
                format!("Page {page} of section \"{name}\" of the file \"{path}\" cannot be read"),
            ),
            ffi::NARSIL_PAGE_INVALID => NarsilError::new(
                ErrorCode::PERSISTENCE_LOAD_FAILED,
                format!(
                    "Page {page} of section \"{name}\" of the file \"{path}\" holds a value that breaks its rules"
                ),
            ),
            status => core_refused("a paged read", status),
        }
    }

    pub(crate) fn call(
        &self,
        sections: &[&PagedSection],
        read: impl FnOnce(
            *mut ffi::narsil_workspace,
            *mut ffi::narsil_page_cache,
            *mut ffi::narsil_page_fault,
        ) -> ffi::narsil_status,
    ) -> Result<ffi::narsil_status> {
        match paged_read(read)? {
            (status @ (ffi::NARSIL_OK | ffi::NARSIL_NEEDS_ROOM), _) => Ok(status),
            (status, fault) => Err(self.page_failed(status, &fault, sections)),
        }
    }

    pub(crate) fn require(
        &self,
        sections: &[&PagedSection],
        status: ffi::narsil_status,
    ) -> Result<()> {
        match status {
            ffi::NARSIL_OK => Ok(()),
            status => Err(self.page_failed(status, &ffi::narsil_page_fault::default(), sections)),
        }
    }

    fn page(&self, section: &PagedSection, page: u64) -> Result<Arc<Vec<u8>>> {
        let start = HEADER_BYTES as u64 + section.offset + page * section.page_bytes;
        if let Some(Cached::Page(bytes)) = cached(self.number, Kind::Page, start) {
            return Ok(bytes);
        }
        let mut bytes = vec![0u8; page_length(section, page)];
        let raw = self.section(section);
        let status = self.call(&[section], |workspace, cache, fault| unsafe {
            ffi::narsil_read_page(
                workspace,
                cache,
                &raw,
                page,
                bytes.as_mut_ptr(),
                bytes.len(),
                fault,
            )
        })?;
        self.require(&[section], status)?;
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

    pub(crate) fn read(
        &self,
        section: &PagedSection,
        position: u64,
        length: u64,
    ) -> Result<Vec<u8>> {
        let inside = position
            .checked_add(length)
            .is_some_and(|end| end <= section.length);
        if !inside || section.page_bytes == 0 {
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

    fn read_past_the_cache(
        &self,
        section: &PagedSection,
        raw: &ffi::narsil_page_section,
        page: u64,
        target: &mut [u8],
    ) -> Result<()> {
        let mut fault = ffi::narsil_page_fault::default();
        let status = with_workspace(|workspace| {
            Ok(unsafe {
                ffi::narsil_read_page(
                    workspace,
                    ptr::null_mut(),
                    raw,
                    page,
                    target.as_mut_ptr(),
                    target.len(),
                    &mut fault,
                )
            })
        })?;
        match status {
            ffi::NARSIL_OK => Ok(()),
            status => Err(self.page_failed(status, &fault, &[section])),
        }
    }

    pub(crate) fn whole_checked(&self, section: &PagedSection) -> Result<Vec<u8>> {
        let mut bytes = vec![0u8; section.length as usize];
        if section.page_bytes == 0 {
            return Err(unreadable(&self.path, section.offset));
        }
        let raw = self.section(section);
        for (page, chunk) in bytes.chunks_mut(section.page_bytes as usize).enumerate() {
            self.read_past_the_cache(section, &raw, page as u64, chunk)?;
        }
        Ok(bytes)
    }

    pub(crate) fn check_every_page(&self, section: &PagedSection) -> Result<()> {
        if section.page_bytes == 0 {
            return Err(unreadable(&self.path, section.offset));
        }
        let raw = self.section(section);
        let mut held = vec![0u8; page_length(section, 0)];
        for page in 0..section.page_count() {
            let length = page_length(section, page);
            let Some(target) = held.get_mut(..length) else {
                return Err(unreadable(&self.path, section.offset));
            };
            self.read_past_the_cache(section, &raw, page, target)?;
        }
        Ok(())
    }
}
