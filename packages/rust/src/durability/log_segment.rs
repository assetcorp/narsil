use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::Arc;

use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::envelope::MAX_FILE_BYTES;
use crate::format::wal::{
    Operation, SEGMENT_HEADER_BYTES, WAL_FORMAT_VERSION_AT, segment_header, segment_version,
};

use super::files::{DurableDirectory, fsync_failed, write_failed};
use super::platform::sync_file;

pub(crate) fn wal_prefix(index_name: &str, partition_id: u32) -> String {
    format!("{index_name}/wal/{partition_id}/")
}

pub(crate) fn wal_segment_key(index_name: &str, partition_id: u32, start_seq_no: u64) -> String {
    format!("{}{start_seq_no:016}", wal_prefix(index_name, partition_id))
}

pub(crate) fn prepared_segment_key(index_name: &str, partition_id: u32) -> String {
    format!("{}next", wal_prefix(index_name, partition_id))
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct LogWrite {
    pub(crate) operation: Operation,
    pub(crate) document_id: String,
    pub(crate) document: Option<Vec<u8>>,
    pub(crate) previous_document: Option<Option<Vec<u8>>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ActiveTail {
    pub(crate) start_seq_no: u64,
    pub(crate) byte_length: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LogStart {
    pub(crate) active: Option<ActiveTail>,
    pub(crate) highest_seq_no: u64,
    pub(crate) highest_durable_seq_no: u64,
    pub(crate) primary_term: u64,
}

pub(crate) struct ActiveSegment {
    pub(crate) key: String,
    pub(crate) start: u64,
    pub(crate) bytes: u64,
    pub(crate) version: u8,
    pub(crate) file: Arc<File>,
}

fn header_version(key: &str, path: &std::path::Path) -> Result<u8> {
    let mut header = [0u8; SEGMENT_HEADER_BYTES];
    File::open(path)
        .and_then(|mut file| file.read_exact(&mut header))
        .map_err(|error| write_failed(key, &error))?;
    segment_version(&header).ok_or_else(|| {
        NarsilError::new(
            ErrorCode::PERSISTENCE_SAVE_FAILED,
            format!("The log segment \"{key}\" holds no header"),
        )
    })
}

impl ActiveSegment {
    pub(crate) fn holds_records(&self) -> bool {
        self.bytes > SEGMENT_HEADER_BYTES as u64
    }

    pub(crate) fn resume(
        directory: &DurableDirectory,
        key: String,
        tail: ActiveTail,
    ) -> Result<ActiveSegment> {
        let (path, _) = directory.ensure_parent(&key)?;
        let file = OpenOptions::new()
            .append(true)
            .open(&path)
            .map_err(|error| write_failed(&key, &error))?;
        let length = file
            .metadata()
            .map_err(|error| write_failed(&key, &error))?
            .len();
        if length != tail.byte_length || length < SEGMENT_HEADER_BYTES as u64 {
            return Err(NarsilError::new(
                ErrorCode::PERSISTENCE_SAVE_FAILED,
                format!(
                    "The log segment \"{key}\" holds {length} bytes where recovery left {}",
                    tail.byte_length
                ),
            ));
        }
        let version = header_version(&key, &path)?;
        Ok(ActiveSegment {
            key,
            start: tail.start_seq_no,
            bytes: length,
            version,
            file: Arc::new(file),
        })
    }

    pub(crate) fn create(
        directory: &DurableDirectory,
        key: String,
        start: u64,
        version: u8,
    ) -> Result<ActiveSegment> {
        let (path, _) = directory.ensure_parent(&key)?;
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&path)
            .map_err(|error| write_failed(&key, &error))?;
        file.write_all(&segment_header(version))
            .map_err(|error| write_failed(&key, &error))?;
        directory.sync_directory_of(&key)?;
        Ok(ActiveSegment {
            key,
            start,
            bytes: SEGMENT_HEADER_BYTES as u64,
            version,
            file: Arc::new(file),
        })
    }

    /// Rewrites the framing version in the header of a segment that holds no record yet. A crash during the
    /// one-byte write leaves either version in place, and a reader accepts both for an empty segment.
    pub(crate) fn raise_empty_version(
        &mut self,
        directory: &DurableDirectory,
        version: u8,
    ) -> Result<()> {
        let path = directory.path_of(&self.key)?;
        let mut file = OpenOptions::new()
            .write(true)
            .open(&path)
            .map_err(|error| write_failed(&self.key, &error))?;
        file.seek(SeekFrom::Start(WAL_FORMAT_VERSION_AT as u64))
            .and_then(|_| file.write_all(&[version]))
            .map_err(|error| write_failed(&self.key, &error))?;
        sync_file(&file).map_err(|error| fsync_failed(&self.key, &error))?;
        self.version = version;
        Ok(())
    }

    pub(crate) fn write_frames(&mut self, frames: &[u8]) -> Result<()> {
        if self.bytes + frames.len() as u64 > MAX_FILE_BYTES {
            return Err(NarsilError::new(
                ErrorCode::PERSISTENCE_SAVE_FAILED,
                format!(
                    "A log record of {} bytes would carry WAL segment \"{}\" past the file size limit of {MAX_FILE_BYTES} bytes",
                    frames.len(),
                    self.key
                ),
            ));
        }
        (&*self.file)
            .write_all(frames)
            .map_err(|error| write_failed(&self.key, &error))?;
        self.bytes += frames.len() as u64;
        Ok(())
    }
}
