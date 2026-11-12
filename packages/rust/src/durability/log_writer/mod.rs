use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};

use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::wal::{
    EntryPlace, LogEntry, SEGMENT_HEADER_BYTES, WAL_FORMAT_VERSION,
    WAL_FORMAT_VERSION_WITH_PREVIOUS_DOCUMENT, frame_record,
};

mod flushing;

use super::files::DurableDirectory;
use super::log_segment::{ActiveSegment, ActiveTail, LogStart, LogWrite, wal_segment_key};
use super::marker::MarkerFile;

const MAX_SEQ_NO: u64 = 9_007_199_254_740_991;

struct LogState {
    active: Option<ActiveSegment>,
    resume: Option<ActiveTail>,
    highest_appended: u64,
    highest_durable: u64,
    primary_term: u64,
    flushing: bool,
    failure: Option<NarsilError>,
    closed: bool,
}

pub(crate) struct PartitionLog {
    index_name: String,
    partition_id: u32,
    segment_max_bytes: u64,
    records_previous_documents: Arc<AtomicBool>,
    state: Mutex<LogState>,
    marker: Mutex<Option<MarkerFile>>,
    changed: Condvar,
}

fn poisoned() -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_SAVE_FAILED,
        "A thread failed while it held the log of a partition, so the log accepts no more writes",
    )
}

struct DurablePoint {
    key: String,
    start: u64,
    bytes: u64,
    highest: u64,
    file: Arc<std::fs::File>,
}

impl PartitionLog {
    pub(crate) fn new(
        index_name: &str,
        partition_id: u32,
        segment_max_bytes: u64,
        records_previous_documents: Arc<AtomicBool>,
        start: LogStart,
    ) -> PartitionLog {
        PartitionLog {
            index_name: index_name.to_string(),
            partition_id,
            segment_max_bytes,
            records_previous_documents,
            state: Mutex::new(LogState {
                active: None,
                resume: start.active,
                highest_appended: start.highest_seq_no,
                highest_durable: start.highest_durable_seq_no.min(start.highest_seq_no),
                primary_term: start.primary_term,
                flushing: false,
                failure: None,
                closed: false,
            }),
            marker: Mutex::new(None),
            changed: Condvar::new(),
        }
    }

    pub(crate) fn partition_id(&self) -> u32 {
        self.partition_id
    }

    fn lock(&self) -> Result<MutexGuard<'_, LogState>> {
        self.state.lock().map_err(|_| poisoned())
    }

    fn idle(&self) -> Result<MutexGuard<'_, LogState>> {
        let mut guard = self.lock()?;
        while guard.flushing {
            guard = self.changed.wait(guard).map_err(|_| poisoned())?;
        }
        Ok(guard)
    }

    fn usable(&self, state: &LogState) -> Result<()> {
        if let Some(failure) = &state.failure {
            return Err(failure.clone());
        }
        if state.closed {
            return Err(NarsilError::new(
                ErrorCode::PERSISTENCE_SAVE_FAILED,
                format!(
                    "The log of partition {} of index \"{}\" is closed",
                    self.partition_id, self.index_name
                ),
            ));
        }
        Ok(())
    }

    fn record_failure(&self, state: &mut LogState, outcome: &Result<impl Sized>) {
        if let Err(error) = outcome {
            if state.failure.is_none() {
                state.failure = Some(error.clone());
            }
            self.changed.notify_all();
        }
    }

    pub(crate) fn highest_appended(&self) -> Result<u64> {
        Ok(self.lock()?.highest_appended)
    }

    pub(crate) fn highest_durable(&self) -> Result<u64> {
        let state = self.lock()?;
        Ok(state.highest_durable.min(state.highest_appended))
    }

    fn new_segment_version(&self, holds_previous_documents: bool) -> u8 {
        if holds_previous_documents || self.records_previous_documents.load(Ordering::Acquire) {
            WAL_FORMAT_VERSION_WITH_PREVIOUS_DOCUMENT
        } else {
            WAL_FORMAT_VERSION
        }
    }

    fn start_segment(
        &self,
        state: &mut LogState,
        directory: &DurableDirectory,
        start: u64,
        version: u8,
    ) -> Result<()> {
        self.flush_locked(state, directory)?;
        state.active = None;
        state.resume = None;
        let key = wal_segment_key(&self.index_name, self.partition_id, start);
        state.active = Some(ActiveSegment::create(directory, key, start, version)?);
        self.flush_locked(state, directory)
    }

    fn ensure_active(
        &self,
        state: &mut LogState,
        directory: &DurableDirectory,
        first: u64,
        version: u8,
    ) -> Result<()> {
        if state.active.is_none() {
            match state.resume.take() {
                Some(tail) => {
                    let key =
                        wal_segment_key(&self.index_name, self.partition_id, tail.start_seq_no);
                    state.active = Some(ActiveSegment::resume(directory, key, tail)?);
                }
                None => return self.start_segment(state, directory, first, version),
            }
        }
        let Some(active) = state.active.as_mut() else {
            return Err(poisoned());
        };
        if active.version >= version {
            return Ok(());
        }
        if active.holds_records() {
            return self.start_segment(state, directory, first, version);
        }
        active.raise_empty_version(directory, version)
    }

    fn write_pending(
        state: &mut LogState,
        directory: &DurableDirectory,
        pending: &mut Vec<u8>,
        last_seq_no: u64,
    ) -> Result<()> {
        if pending.is_empty() {
            return Ok(());
        }
        let Some(active) = state.active.as_mut() else {
            return Err(poisoned());
        };
        let written = active.write_frames(pending);
        let measured = match &written {
            Ok(()) => Some(active.bytes),
            Err(_) => directory.byte_length(&active.key).ok().flatten(),
        };
        if let Some(bytes) = measured {
            directory.log_bytes().set(&active.key, bytes);
        }
        written?;
        pending.clear();
        state.highest_appended = last_seq_no;
        Ok(())
    }

    fn append_locked(
        &self,
        state: &mut LogState,
        directory: &DurableDirectory,
        writes: Vec<LogWrite>,
    ) -> Result<(u64, u64)> {
        let first = state.highest_appended + 1;
        if state.highest_appended.saturating_add(writes.len() as u64) > MAX_SEQ_NO {
            return Err(NarsilError::new(
                ErrorCode::PERSISTENCE_SAVE_FAILED,
                format!(
                    "Partition {} of index \"{}\" has run out of sequence numbers",
                    self.partition_id, self.index_name
                ),
            ));
        }
        let holds_previous = writes.iter().any(|write| write.previous_document.is_some());
        let version = self.new_segment_version(holds_previous);
        self.ensure_active(state, directory, first, version)?;
        let (mut pending, mut frame) = (Vec::new(), Vec::new());
        let mut seq_no = state.highest_appended;
        for write in writes {
            seq_no += 1;
            let place = EntryPlace {
                seq_no,
                primary_term: state.primary_term,
                partition_id: self.partition_id,
                index_name: &self.index_name,
            };
            let entry = LogEntry::new(
                place,
                write.operation,
                &write.document_id,
                write.document,
                write.previous_document,
            );
            frame.clear();
            frame_record(&entry, &mut frame)?;
            let active_bytes = state.active.as_ref().map_or(0, |active| active.bytes);
            let held = active_bytes + pending.len() as u64;
            let holds_records = held > SEGMENT_HEADER_BYTES as u64;
            if holds_records && held + frame.len() as u64 > self.segment_max_bytes {
                Self::write_pending(state, directory, &mut pending, seq_no - 1)?;
                self.start_segment(state, directory, seq_no, version)?;
            }
            pending.extend_from_slice(&frame);
        }
        Self::write_pending(state, directory, &mut pending, seq_no)?;
        Ok((first, seq_no))
    }

    pub(crate) fn append(
        &self,
        directory: &DurableDirectory,
        writes: Vec<LogWrite>,
    ) -> Result<(u64, u64)> {
        let mut state = self.lock()?;
        self.usable(&state)?;
        if writes.is_empty() {
            return Ok((state.highest_appended + 1, state.highest_appended));
        }
        let outcome = self.append_locked(&mut state, directory, writes);
        self.record_failure(&mut state, &outcome);
        outcome
    }

    pub(crate) fn roll_for_checkpoint(&self, directory: &DurableDirectory) -> Result<()> {
        let mut state = self.idle()?;
        self.usable(&state)?;
        let holds_records = state
            .active
            .as_ref()
            .is_some_and(ActiveSegment::holds_records)
            || state
                .resume
                .is_some_and(|tail| tail.byte_length > SEGMENT_HEADER_BYTES as u64);
        if !holds_records {
            return Ok(());
        }
        let next = state.highest_appended + 1;
        let outcome = self
            .ensure_active(&mut state, directory, next, WAL_FORMAT_VERSION)
            .and_then(|_| {
                let version = self.new_segment_version(false);
                self.start_segment(&mut state, directory, next, version)
            });
        self.record_failure(&mut state, &outcome);
        outcome
    }
}
