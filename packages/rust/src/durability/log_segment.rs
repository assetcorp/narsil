use std::fs::{File, OpenOptions};
use std::io::Write;
use std::sync::Arc;

use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::envelope::MAX_FILE_BYTES;
use crate::format::wal::{Operation, SEGMENT_HEADER_BYTES, segment_header};

use super::files::{DurableDirectory, write_failed};

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
    pub(crate) file: Arc<File>,
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
        Ok(ActiveSegment {
            key,
            start: tail.start_seq_no,
            bytes: length,
            file: Arc::new(file),
        })
    }

    pub(crate) fn create(
        directory: &DurableDirectory,
        key: String,
        start: u64,
    ) -> Result<ActiveSegment> {
        let (path, _) = directory.ensure_parent(&key)?;
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&path)
            .map_err(|error| write_failed(&key, &error))?;
        file.write_all(&segment_header())
            .map_err(|error| write_failed(&key, &error))?;
        directory.sync_directory_of(&key)?;
        Ok(ActiveSegment {
            key,
            start,
            bytes: SEGMENT_HEADER_BYTES as u64,
            file: Arc::new(file),
        })
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
