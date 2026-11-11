use crate::error::{ErrorCode, NarsilError, Result};

use super::super::files::{DurableDirectory, fsync_failed};
use super::super::marker::{MarkerFile, marker_key};
use super::super::platform::sync_file;
use super::{DurablePoint, LogState, PartitionLog, poisoned};

impl PartitionLog {
    pub(super) fn durable_point(state: &LogState) -> Option<DurablePoint> {
        state.active.as_ref().map(|active| DurablePoint {
            key: active.key.clone(),
            start: active.start,
            bytes: active.bytes,
            highest: state.highest_appended.max(state.highest_durable),
            file: active.file.clone(),
        })
    }

    fn make_durable(&self, directory: &DurableDirectory, point: &DurablePoint) -> Result<()> {
        sync_file(&point.file).map_err(|error| fsync_failed(&point.key, &error))?;
        let mut slot = self.marker.lock().map_err(|_| poisoned())?;
        if slot.is_none() {
            *slot = Some(MarkerFile::open(
                directory,
                &marker_key(&self.index_name, self.partition_id),
            )?);
        }
        let Some(marker) = slot.as_mut() else {
            return Err(poisoned());
        };
        let mut highest = point.highest;
        if let Some(current) = marker.existing() {
            let committed = (current.active_segment_seq_no, current.durable_byte_length);
            if (point.start, point.bytes) < committed {
                return Ok(());
            }
            highest = highest.max(current.highest_durable_seq_no);
        }
        marker.commit(point.start, point.bytes, highest)
    }

    pub(super) fn flush_locked(
        &self,
        state: &mut LogState,
        directory: &DurableDirectory,
    ) -> Result<()> {
        let Some(point) = Self::durable_point(state) else {
            return Ok(());
        };
        self.make_durable(directory, &point)?;
        state.highest_durable = state.highest_durable.max(point.highest);
        Ok(())
    }

    pub(crate) fn flush_to(
        &self,
        directory: &DurableDirectory,
        target: u64,
        verify: &dyn Fn() -> Result<()>,
    ) -> Result<()> {
        let mut state = self.lock()?;
        loop {
            if let Some(failure) = &state.failure {
                return Err(failure.clone());
            }
            if state.highest_durable >= target {
                return Ok(());
            }
            if state.flushing {
                state = self.changed.wait(state).map_err(|_| poisoned())?;
                continue;
            }
            let Some(point) = Self::durable_point(&state) else {
                return Err(NarsilError::new(
                    ErrorCode::PERSISTENCE_SAVE_FAILED,
                    format!(
                        "Partition {} of index \"{}\" has no log record {target} to make durable",
                        self.partition_id, self.index_name
                    ),
                ));
            };
            state.flushing = true;
            drop(state);
            let outcome = self.make_durable(directory, &point).and_then(|_| verify());
            let mut relocked = self
                .state
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            relocked.flushing = false;
            if outcome.is_ok() {
                relocked.highest_durable = relocked.highest_durable.max(point.highest);
            }
            self.record_failure(&mut relocked, &outcome);
            self.changed.notify_all();
            outcome?;
            state = relocked;
        }
    }

    pub(crate) fn flush(
        &self,
        directory: &DurableDirectory,
        verify: &dyn Fn() -> Result<()>,
    ) -> Result<()> {
        let target = self.highest_appended()?;
        self.flush_to(directory, target, verify)
    }

    pub(crate) fn fail(&self, error: &NarsilError) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if state.failure.is_none() {
            state.failure = Some(error.clone());
        }
        self.changed.notify_all();
    }

    pub(crate) fn close(&self, directory: &DurableDirectory) -> Result<()> {
        let mut state = self.idle()?;
        if state.closed {
            return Ok(());
        }
        let outcome = if state.failure.is_none() && state.highest_appended > state.highest_durable {
            self.flush_locked(&mut state, directory)
        } else {
            Ok(())
        };
        state.closed = true;
        state.active = None;
        if let Ok(mut marker) = self.marker.lock() {
            *marker = None;
        }
        self.changed.notify_all();
        outcome
    }
}
