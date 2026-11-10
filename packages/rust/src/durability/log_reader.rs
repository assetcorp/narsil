use std::fs::OpenOptions;

use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::envelope::MAX_FILE_BYTES;
use crate::format::wal::{
    COMMIT_MARKER_FILE_BYTES, CommitMarker, LogEntry, SEGMENT_HEADER_BYTES, check_segment_header,
    read_commit_marker, read_durable_region, read_tail,
};

use super::files::{DurableDirectory, fsync_failed, write_failed};
use super::log_segment::{ActiveTail, prepared_segment_key, wal_prefix};
use super::marker::{MarkerFile, marker_key};
use super::platform::sync_file;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LogReplayed {
    pub(crate) highest_seq_no: u64,
    pub(crate) highest_primary_term: u64,
    pub(crate) active: Option<ActiveTail>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SegmentFile {
    pub(crate) key: String,
    pub(crate) start_seq_no: u64,
}

pub(crate) fn segment_start(key: &str, prefix: &str) -> Option<u64> {
    let tail = key.strip_prefix(prefix)?;
    if tail.len() != 16 || !tail.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    tail.parse::<u64>()
        .ok()
        .filter(|value| *value <= 9_007_199_254_740_991)
}

pub(crate) fn list_segments(
    directory: &DurableDirectory,
    index_name: &str,
    partition_id: u32,
) -> Result<Vec<SegmentFile>> {
    let prefix = wal_prefix(index_name, partition_id);
    let mut segments: Vec<SegmentFile> = directory
        .list(&prefix)?
        .into_iter()
        .filter_map(|key| {
            segment_start(&key, &prefix).map(|start_seq_no| SegmentFile { key, start_seq_no })
        })
        .collect();
    segments.sort_by_key(|segment| segment.start_seq_no);
    Ok(segments)
}

pub(crate) fn read_marker(
    directory: &DurableDirectory,
    index_name: &str,
    partition_id: u32,
) -> Result<Option<CommitMarker>> {
    let key = marker_key(index_name, partition_id);
    let Some(bytes) = directory.read_within(&key, MAX_FILE_BYTES)? else {
        return Ok(None);
    };
    let usable = &bytes[..bytes.len().min(COMMIT_MARKER_FILE_BYTES)];
    Ok(read_commit_marker(usable).map(|(state, _)| state))
}

fn durable_record_missing(
    index_name: &str,
    partition_id: u32,
    highest: u64,
    marker: &CommitMarker,
) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_WAL_CORRUPT,
        format!(
            "A durable WAL record is missing: the highest recovered seqNo is below the commit marker (index \"{index_name}\", partition {partition_id}, read {highest}, durable {})",
            marker.highest_durable_seq_no
        ),
    )
}

fn read_segment(directory: &DurableDirectory, key: &str) -> Result<Option<Vec<u8>>> {
    directory.read_within(key, MAX_FILE_BYTES).map_err(|error| {
        if error.code() == ErrorCode::PERSISTENCE_LOAD_FAILED {
            NarsilError::new(ErrorCode::PERSISTENCE_WAL_CORRUPT, error.message())
        } else {
            error
        }
    })
}

fn sealed_header_error(key: &str, error: NarsilError) -> NarsilError {
    let reason = error
        .message()
        .strip_prefix("WAL segment header invalid in durable region: ")
        .unwrap_or(error.message())
        .to_string();
    NarsilError::new(
        error.code(),
        format!("Sealed WAL segment header invalid: {reason} (\"{key}\")"),
    )
}

pub(crate) struct LogVisit<'a> {
    pub(crate) after_seq_no: u64,
    pub(crate) up_to_seq_no: u64,
    pub(crate) visit: &'a mut dyn FnMut(LogEntry) -> Result<()>,
}

fn deliver(
    entries: Vec<LogEntry>,
    visit: &mut LogVisit<'_>,
    highest_term: &mut u64,
    delivered: &mut u64,
) -> Result<()> {
    for entry in entries {
        let seq_no = entry.seq_no as u64;
        if seq_no <= visit.after_seq_no || seq_no <= *delivered || seq_no > visit.up_to_seq_no {
            continue;
        }
        *highest_term = (*highest_term).max(entry.primary_term as u64);
        *delivered = seq_no;
        (visit.visit)(entry)?;
    }
    Ok(())
}

struct TailRepair {
    key: String,
    clean_end: u64,
    segment_length: u64,
    last_tail_seq_no: Option<u64>,
}

fn make_tail_durable(
    directory: &DurableDirectory,
    index_name: &str,
    partition_id: u32,
    marker: &CommitMarker,
    tail: &TailRepair,
) -> Result<()> {
    let key = tail.key.as_str();
    if tail.last_tail_seq_no.is_none() && tail.clean_end >= tail.segment_length {
        return Ok(());
    }
    let path = directory.path_of(key)?;
    let file = OpenOptions::new()
        .write(true)
        .open(&path)
        .map_err(|error| write_failed(key, &error))?;
    if tail.clean_end < tail.segment_length {
        file.set_len(tail.clean_end)
            .map_err(|error| write_failed(key, &error))?;
    }
    sync_file(&file).map_err(|error| fsync_failed(key, &error))?;
    let Some(last) = tail.last_tail_seq_no else {
        return Ok(());
    };
    let mut writer = MarkerFile::open(directory, &marker_key(index_name, partition_id))?;
    writer.commit(
        marker.active_segment_seq_no,
        tail.clean_end,
        marker.highest_durable_seq_no.max(last),
    )
}

pub(crate) fn remove_partition_log(
    directory: &DurableDirectory,
    index_name: &str,
    partition_id: u32,
) -> Result<()> {
    for segment in list_segments(directory, index_name, partition_id)? {
        directory.remove(&segment.key)?;
    }
    directory.remove(&marker_key(index_name, partition_id))
}

pub(crate) fn replay_partition_log(
    directory: &DurableDirectory,
    index_name: &str,
    partition_id: u32,
    mut visit: LogVisit<'_>,
    repairs: bool,
) -> Result<LogReplayed> {
    if repairs {
        directory.remove(&prepared_segment_key(index_name, partition_id))?;
    }
    let mut replayed = LogReplayed {
        highest_seq_no: visit.after_seq_no,
        highest_primary_term: 0,
        active: None,
    };
    let Some(marker) = read_marker(directory, index_name, partition_id)? else {
        if repairs {
            remove_partition_log(directory, index_name, partition_id)?;
        }
        return Ok(replayed);
    };
    let segments = list_segments(directory, index_name, partition_id)?;
    let mut highest_read = 0u64;
    let mut delivered = visit.after_seq_no;
    let mut term = 0u64;
    let mut tail_state: Option<TailRepair> = None;
    for segment in &segments {
        if segment.start_seq_no > marker.active_segment_seq_no {
            continue;
        }
        let Some(bytes) = read_segment(directory, &segment.key)? else {
            continue;
        };
        let sealed = segment.start_seq_no < marker.active_segment_seq_no;
        let durable_length = if sealed {
            check_segment_header(&bytes)
                .map_err(|error| sealed_header_error(&segment.key, error))?;
            bytes.len()
        } else {
            usize::try_from(marker.durable_byte_length).unwrap_or(usize::MAX)
        };
        let entries = read_durable_region(&bytes, durable_length)?;
        highest_read = entries
            .iter()
            .fold(highest_read, |high, entry| high.max(entry.seq_no as u64));
        deliver(entries, &mut visit, &mut term, &mut delivered)?;
        if sealed {
            continue;
        }
        let floor = highest_read.max(marker.highest_durable_seq_no);
        let (tail, clean_end) = read_tail(&bytes, durable_length, floor as f64);
        let last_tail = tail.last().map(|entry| entry.seq_no as u64);
        deliver(tail, &mut visit, &mut term, &mut delivered)?;
        tail_state = Some(TailRepair {
            key: segment.key.clone(),
            clean_end: (clean_end as u64).max(SEGMENT_HEADER_BYTES as u64),
            segment_length: bytes.len() as u64,
            last_tail_seq_no: last_tail,
        });
    }
    if visit.after_seq_no.max(highest_read) < marker.highest_durable_seq_no {
        return Err(durable_record_missing(
            index_name,
            partition_id,
            highest_read,
            &marker,
        ));
    }
    replayed.highest_seq_no = delivered;
    replayed.highest_primary_term = term;
    if !repairs {
        return Ok(replayed);
    }
    for segment in &segments {
        if segment.start_seq_no > marker.active_segment_seq_no {
            directory.remove(&segment.key)?;
        }
    }
    if let Some(tail) = tail_state {
        make_tail_durable(directory, index_name, partition_id, &marker, &tail)?;
        replayed.active = Some(ActiveTail {
            start_seq_no: marker.active_segment_seq_no,
            byte_length: tail.clean_end,
        });
    }
    Ok(replayed)
}
