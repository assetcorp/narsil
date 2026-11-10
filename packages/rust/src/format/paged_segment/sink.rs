use std::ffi::OsString;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use super::SEGMENT_PAGE_BYTES;
use super::constants::{FILE_ASSEMBLY_CHUNK_BYTES, SECTION_WRITE_BUFFER_BYTES};
use crate::error::{ErrorCode, NarsilError, Result};

fn scratch_failed(path: &Path, verb: &str, error: &std::io::Error) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_SAVE_FAILED,
        format!(
            "The scratch file \"{}\" failed to {verb}: {error}",
            path.display()
        ),
    )
}

/// A file that a paged segment writer holds part of a segment in while it writes, removed once the writer drops
/// it, whether the write succeeds or fails.
pub(crate) struct ScratchFile {
    path: PathBuf,
    file: Option<File>,
}

impl Drop for ScratchFile {
    fn drop(&mut self) {
        self.file = None;
        let _ = std::fs::remove_file(&self.path);
    }
}

impl ScratchFile {
    /// Creates the scratch file at `path`, emptying a file that a write cut short there left behind.
    pub(crate) fn create(path: PathBuf) -> Result<ScratchFile> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(&path)
            .map_err(|error| scratch_failed(&path, "open", &error))?;
        Ok(ScratchFile {
            path,
            file: Some(file),
        })
    }

    fn handle(&mut self) -> Result<&mut File> {
        let path = &self.path;
        self.file.as_mut().ok_or_else(|| {
            NarsilError::new(
                ErrorCode::PERSISTENCE_SAVE_FAILED,
                format!("The scratch file \"{}\" is already closed", path.display()),
            )
        })
    }

    pub(crate) fn append(&mut self, bytes: &[u8]) -> Result<()> {
        let path = self.path.clone();
        self.handle()?
            .write_all(bytes)
            .map_err(|error| scratch_failed(&path, "take a write", &error))
    }

    /// Moves to the start of the file, so that later reads return its bytes from the first.
    pub(crate) fn rewind(&mut self) -> Result<u64> {
        let path = self.path.clone();
        let file = self.handle()?;
        let length = file
            .metadata()
            .map_err(|error| scratch_failed(&path, "report its length", &error))?
            .len();
        file.seek(SeekFrom::Start(0))
            .map_err(|error| scratch_failed(&path, "seek", &error))?;
        Ok(length)
    }

    pub(crate) fn read_exact(&mut self, target: &mut [u8]) -> Result<()> {
        let path = self.path.clone();
        self.handle()?
            .read_exact(target)
            .map_err(|error| scratch_failed(&path, "return its bytes", &error))
    }
}

/// The paths of the scratch files of one paged segment write, each the base path with the part's name after it.
pub(crate) struct ScratchNames {
    base: OsString,
}

impl ScratchNames {
    pub(crate) fn new(base: PathBuf) -> ScratchNames {
        ScratchNames {
            base: base.into_os_string(),
        }
    }

    pub(crate) fn create(&self, part: &str) -> Result<ScratchFile> {
        let mut path = self.base.clone();
        path.push("-");
        path.push(part);
        ScratchFile::create(PathBuf::from(path))
    }
}

/// One section of a paged segment that a writer appends to a scratch file through a fixed buffer, taking the
/// CRC-32 of each page as the bytes pass.
pub(crate) struct SectionSink {
    name: &'static str,
    scratch: ScratchFile,
    buffer: Vec<u8>,
    page: crc32fast::Hasher,
    page_filled: u64,
    checksums: Vec<u8>,
    length: u64,
}

/// A section that a writer finished: its scratch file, its length, and the CRC-32 of each page.
pub(crate) struct FinishedSection {
    pub(crate) name: &'static str,
    pub(crate) length: u64,
    pub(crate) checksums: Vec<u8>,
    scratch: ScratchFile,
}

impl SectionSink {
    pub(crate) fn open(names: &ScratchNames, name: &'static str) -> Result<SectionSink> {
        Ok(SectionSink {
            name,
            scratch: names.create(name)?,
            buffer: Vec::with_capacity(SECTION_WRITE_BUFFER_BYTES),
            page: crc32fast::Hasher::new(),
            page_filled: 0,
            checksums: Vec::new(),
            length: 0,
        })
    }

    fn checksum_page(&mut self) {
        let hasher = std::mem::replace(&mut self.page, crc32fast::Hasher::new());
        self.checksums
            .extend_from_slice(&hasher.finalize().to_le_bytes());
        self.page_filled = 0;
    }

    pub(crate) fn write(&mut self, bytes: &[u8]) -> Result<()> {
        let mut rest = bytes;
        while !rest.is_empty() {
            let room = (SEGMENT_PAGE_BYTES - self.page_filled).min(rest.len() as u64) as usize;
            let (taken, after) = rest.split_at(room);
            self.page.update(taken);
            self.page_filled += taken.len() as u64;
            if self.page_filled == SEGMENT_PAGE_BYTES {
                self.checksum_page();
            }
            rest = after;
        }
        self.length += bytes.len() as u64;
        if self.buffer.len() + bytes.len() > SECTION_WRITE_BUFFER_BYTES {
            self.flush()?;
        }
        if bytes.len() >= SECTION_WRITE_BUFFER_BYTES {
            return self.scratch.append(bytes);
        }
        self.buffer.extend_from_slice(bytes);
        Ok(())
    }

    pub(crate) fn write_u32(&mut self, value: u32) -> Result<()> {
        self.write(&value.to_le_bytes())
    }

    fn flush(&mut self) -> Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        self.scratch.append(&self.buffer)?;
        self.buffer.clear();
        Ok(())
    }

    pub(crate) fn finish(mut self) -> Result<FinishedSection> {
        self.flush()?;
        if self.page_filled > 0 {
            self.checksum_page();
        }
        let SectionSink {
            name,
            scratch,
            checksums,
            length,
            ..
        } = self;
        Ok(FinishedSection {
            name,
            length,
            checksums,
            scratch,
        })
    }
}

impl FinishedSection {
    /// Hands every byte of the section to `write` in chunks of at most `FILE_ASSEMBLY_CHUNK_BYTES`, reading the
    /// scratch file from its start, and raises `PERSISTENCE_SAVE_FAILED` where the file holds another length.
    pub(crate) fn copy_into(
        &mut self,
        chunk: &mut Vec<u8>,
        write: &mut dyn FnMut(&[u8]) -> Result<()>,
    ) -> Result<()> {
        let stored = self.scratch.rewind()?;
        if stored != self.length {
            return Err(NarsilError::new(
                ErrorCode::PERSISTENCE_SAVE_FAILED,
                format!(
                    "The scratch file of section \"{}\" holds {stored} bytes where the writer wrote {}",
                    self.name, self.length
                ),
            ));
        }
        let mut left = self.length;
        while left > 0 {
            let take = left.min(FILE_ASSEMBLY_CHUNK_BYTES as u64) as usize;
            chunk.resize(take, 0);
            self.scratch.read_exact(chunk)?;
            write(chunk)?;
            left -= take as u64;
        }
        Ok(())
    }
}
