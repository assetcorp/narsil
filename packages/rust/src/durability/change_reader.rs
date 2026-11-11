use std::fs::File;
use std::io::{BufReader, ErrorKind, Read, Seek, SeekFrom};

use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::wal::{
    FRAME_CRC_BYTES, LogEntry, MAX_WAL_RECORD_BYTES, RECORD_LENGTH_BYTES, SEGMENT_HEADER_BYTES,
    check_segment_header, decode_entry,
};
use crate::util::hash::crc32;

use super::files::{DurableDirectory, read_failed};
use super::log_reader::list_segments;
use super::store::DurabilityStore;
use super::sync_files::list_history;

const READ_BUFFER_BYTES: usize = 65_536;

/// The positions of one partition's log that a reader of changes compares a subscriber's position with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LogPositions {
    pub(crate) head: u64,
    pub(crate) highest: u64,
    pub(crate) oldest: u64,
}

struct OpenSegment {
    start: u64,
    key: String,
    reader: BufReader<File>,
    offset: u64,
    length: u64,
}

/// Where a reader of changes stands in one partition's history and log: the highest sequence number that it has
/// read, and the segment that holds the next one, kept open between reads.
pub(crate) struct LogCursor {
    after: u64,
    segment: Option<OpenSegment>,
}

impl LogCursor {
    pub(crate) fn after(seq_no: u64) -> LogCursor {
        LogCursor {
            after: seq_no,
            segment: None,
        }
    }

    pub(crate) fn position(&self) -> u64 {
        self.after
    }
}

/// What one bounded read of a partition returned: the entries above the cursor in sequence order, or the news that
/// history no longer holds the next entry.
pub(crate) enum LogRead {
    Entries(Vec<LogEntry>),
    HistoryGone,
}

fn all_segments(
    directory: &DurableDirectory,
    index_name: &str,
    partition_id: u32,
) -> Result<Vec<(u64, String)>> {
    let mut segments: Vec<(u64, String)> = list_segments(directory, index_name, partition_id)?
        .into_iter()
        .map(|segment| (segment.start_seq_no, segment.key))
        .collect();
    segments.extend(
        list_history(directory, index_name, Some(partition_id))?
            .into_iter()
            .map(|segment| (segment.start_seq_no, segment.key)),
    );
    segments.sort_by_key(|(start, _)| *start);
    segments.dedup_by_key(|(start, _)| *start);
    Ok(segments)
}

fn damaged(key: &str, reason: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_WAL_CORRUPT,
        format!("The log segment \"{key}\" {reason}"),
    )
}

fn open_segment(
    directory: &DurableDirectory,
    start: u64,
    key: &str,
) -> Result<Option<OpenSegment>> {
    let file = match File::open(directory.path_of(key)?) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(read_failed(key, &error)),
    };
    let length = file
        .metadata()
        .map_err(|error| read_failed(key, &error))?
        .len();
    let mut reader = BufReader::with_capacity(READ_BUFFER_BYTES, file);
    let mut header = [0u8; SEGMENT_HEADER_BYTES];
    reader
        .read_exact(&mut header)
        .map_err(|_| damaged(key, "is shorter than its header"))?;
    check_segment_header(&header)?;
    Ok(Some(OpenSegment {
        start,
        key: key.to_string(),
        reader,
        offset: SEGMENT_HEADER_BYTES as u64,
        length,
    }))
}

fn refresh_length(segment: &mut OpenSegment) -> Result<()> {
    segment.length = segment
        .reader
        .get_ref()
        .metadata()
        .map_err(|error| read_failed(&segment.key, &error))?
        .len();
    Ok(())
}

fn rewind(segment: &mut OpenSegment) -> Result<()> {
    segment
        .reader
        .seek(SeekFrom::Start(segment.offset))
        .map(|_| ())
        .map_err(|error| read_failed(&segment.key, &error))
}

fn read_frame(segment: &mut OpenSegment) -> Result<Option<Vec<u8>>> {
    let frame_overhead = (RECORD_LENGTH_BYTES + FRAME_CRC_BYTES) as u64;
    if segment.offset + frame_overhead > segment.length {
        refresh_length(segment)?;
        if segment.offset + frame_overhead > segment.length {
            return Ok(None);
        }
    }
    let mut length_bytes = [0u8; RECORD_LENGTH_BYTES];
    if segment.reader.read_exact(&mut length_bytes).is_err() {
        return Ok(None);
    }
    let length = u32::from_be_bytes(length_bytes) as usize;
    let end = segment.offset + frame_overhead + length as u64;
    if end > segment.length {
        refresh_length(segment)?;
    }
    if length == 0 || length > MAX_WAL_RECORD_BYTES || end > segment.length {
        return Ok(None);
    }
    let mut payload = vec![0u8; length];
    let mut checksum = [0u8; FRAME_CRC_BYTES];
    let read = segment
        .reader
        .read_exact(&mut payload)
        .and_then(|_| segment.reader.read_exact(&mut checksum));
    if read.is_err() || crc32(&payload) != u32::from_be_bytes(checksum) {
        return Ok(None);
    }
    segment.offset = end;
    Ok(Some(payload))
}

fn next_record(segment: &mut OpenSegment) -> Result<Option<(LogEntry, u64)>> {
    let start = segment.offset;
    match read_frame(segment)? {
        Some(payload) => Ok(Some((decode_entry(&payload)?, start))),
        None => {
            rewind(segment)?;
            Ok(None)
        }
    }
}

impl DurabilityStore {
    fn partition_log_bounds(&self, index_name: &str, partition_id: u32) -> Result<(u64, u64)> {
        let log = self
            .inner
            .logs_of(index_name)?
            .into_iter()
            .find(|log| log.partition_id() == partition_id);
        match log {
            Some(log) => Ok((log.highest_durable()?, log.highest_appended()?)),
            None => Ok((0, 0)),
        }
    }

    /// Returns the highest durable sequence number of one partition's log, which a reader of changes reads up to.
    pub(crate) fn log_head(&self, index_name: &str, partition_id: u32) -> Result<u64> {
        Ok(self.partition_log_bounds(index_name, partition_id)?.0)
    }

    /// Returns the head, the highest sequence number, and the oldest sequence number of one partition's log: the
    /// head is the highest durable sequence number, and the oldest is the lowest start of a history or log segment,
    /// or the head plus one where the partition holds no segment.
    pub(crate) fn log_positions(
        &self,
        index_name: &str,
        partition_id: u32,
    ) -> Result<LogPositions> {
        let (head, highest) = self.partition_log_bounds(index_name, partition_id)?;
        let oldest = all_segments(&self.inner.directory, index_name, partition_id)?
            .first()
            .map_or(head.saturating_add(1), |(start, _)| *start);
        Ok(LogPositions {
            head,
            highest,
            oldest,
        })
    }

    /// Returns the length in bytes of the history and log of one partition above `after`, counted from the frame of
    /// the first record above it to the end of the newest segment.
    pub(crate) fn log_bytes_after(
        &self,
        index_name: &str,
        partition_id: u32,
        after: u64,
    ) -> Result<u64> {
        let directory = &self.inner.directory;
        let segments = all_segments(directory, index_name, partition_id)?;
        let first = segments
            .iter()
            .rposition(|(start, _)| *start <= after.saturating_add(1))
            .unwrap_or(0);
        let mut bytes = 0u64;
        for (at, (start, key)) in segments.iter().enumerate().skip(first) {
            let Some(mut segment) = open_segment(directory, *start, key)? else {
                continue;
            };
            if at == first {
                while let Some((entry, frame_start)) = next_record(&mut segment)? {
                    if entry.seq_no as u64 > after {
                        segment.offset = frame_start;
                        break;
                    }
                }
            }
            bytes = bytes.saturating_add(segment.length.saturating_sub(segment.offset));
        }
        Ok(bytes)
    }

    /// Reads the entries of one partition above `cursor` and at or below `up_to`, in sequence order, until they hold
    /// `budget_bytes` of documents. The reader holds one record in memory beyond the entries that it returns, and it
    /// looks for a segment in history where a checkpoint moved it during the read.
    pub(crate) fn read_log_entries(
        &self,
        index_name: &str,
        partition_id: u32,
        cursor: &mut LogCursor,
        up_to: u64,
        budget_bytes: usize,
    ) -> Result<LogRead> {
        let directory = &self.inner.directory;
        let mut entries = Vec::new();
        let mut held = 0usize;
        while cursor.after < up_to && held < budget_bytes {
            if cursor.segment.is_none() {
                let next = cursor.after + 1;
                let segments = all_segments(directory, index_name, partition_id)?;
                let Some((start, key)) = segments.iter().rev().find(|(start, _)| *start <= next)
                else {
                    return Ok(LogRead::HistoryGone);
                };
                match open_segment(directory, *start, key)? {
                    Some(segment) => cursor.segment = Some(segment),
                    None => {
                        let moved = all_segments(directory, index_name, partition_id)?;
                        let Some((start, key)) = moved.iter().find(|(found, _)| found == start)
                        else {
                            return Ok(LogRead::HistoryGone);
                        };
                        let Some(segment) = open_segment(directory, *start, key)? else {
                            return Ok(LogRead::HistoryGone);
                        };
                        cursor.segment = Some(segment);
                    }
                }
            }
            let Some(segment) = cursor.segment.as_mut() else {
                return Ok(LogRead::HistoryGone);
            };
            let Some((entry, frame_start)) = next_record(segment)? else {
                let finished = segment.start;
                let later: Vec<u64> = all_segments(directory, index_name, partition_id)?
                    .into_iter()
                    .map(|(start, _)| start)
                    .filter(|start| *start > finished)
                    .collect();
                if later.iter().any(|start| *start <= cursor.after + 1) {
                    cursor.segment = None;
                    continue;
                }
                if later.is_empty() {
                    return Ok(LogRead::Entries(entries));
                }
                let Some((_, frame_start)) = next_record(segment)? else {
                    return Ok(LogRead::HistoryGone);
                };
                segment.offset = frame_start;
                rewind(segment)?;
                continue;
            };
            let seq_no = entry.seq_no as u64;
            if seq_no <= cursor.after {
                continue;
            }
            if seq_no > up_to {
                segment.offset = frame_start;
                rewind(segment)?;
                break;
            }
            if seq_no != cursor.after + 1 {
                return Ok(LogRead::HistoryGone);
            }
            held += entry_bytes(&entry);
            cursor.after = seq_no;
            entries.push(entry);
        }
        Ok(LogRead::Entries(entries))
    }
}

fn entry_bytes(entry: &LogEntry) -> usize {
    let previous = entry.previous_document.as_ref().and_then(Option::as_ref);
    entry.document.as_ref().map_or(0, Vec::len) + previous.map_or(0, Vec::len) + 1
}
