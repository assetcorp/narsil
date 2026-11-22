use std::sync::Arc;
use std::sync::atomic::Ordering;

use crate::error::Result;

use super::constants::SINGLE_NODE_PRIMARY_TERM;
use super::log_reader::list_segments;
use super::log_segment::{LogStart, LogWrite, prepared_segment_key};
use super::log_writer::PartitionLog;
use super::marker::marker_key;
use super::store::DurabilityStore;
use super::store_config::DurabilityMode;

/// The records of one term that follow one another in a partition's log.
pub(crate) struct AssignedRun {
    pub(crate) first_seq_no: u64,
    pub(crate) primary_term: u64,
    pub(crate) writes: Vec<LogWrite>,
}

/// The log of one partition of a cluster copy, whose failure leaves every other log of the store working.
pub(crate) struct ReplicatedLog<'a> {
    pub(crate) store: &'a DurabilityStore,
    pub(crate) index_name: &'a str,
    pub(crate) partition: u32,
}

impl ReplicatedLog<'_> {
    /// Appends `runs` and returns the log that received them, which alone can confirm that they are durable.
    pub(crate) fn append(&self, runs: Vec<AssignedRun>) -> Result<Arc<PartitionLog>> {
        let inner = &self.store.inner;
        inner.require_healthy()?;
        inner.require_open()?;
        let log = inner.log(self.index_name, self.partition)?;
        let mut count = 0;
        for run in runs {
            count += run.writes.len() as u64;
            log.append_assigned(
                &inner.directory,
                run.first_seq_no,
                run.primary_term,
                run.writes,
            )?;
        }
        inner
            .index_state(self.index_name)?
            .mutations
            .fetch_add(count, Ordering::Relaxed);
        Ok(log)
    }

    /// Waits on the log that received the records, because a log that replaces it counts every earlier record as
    /// durable whether or not the replaced one reached the disk.
    pub(crate) fn wait_durable(&self, log: &PartitionLog, seq_no: u64) -> Result<()> {
        let inner = &self.store.inner;
        inner.require_healthy()?;
        if inner.config.mode == DurabilityMode::Async {
            return Ok(());
        }
        log.flush_to(&inner.directory, seq_no, &|| inner.verify())
    }

    pub(crate) fn is_current(&self, log: &Arc<PartitionLog>) -> bool {
        self.store
            .inner
            .log(self.index_name, self.partition)
            .is_ok_and(|current| Arc::ptr_eq(&current, log))
    }

    /// Puts a new log in place of the partition's, numbered after `seq_no`, so that a checkpoint never meets the
    /// failure of the one that it replaces.
    pub(crate) fn restart_after(&self, seq_no: u64, primary_term: u64) -> Result<()> {
        self.store.inner.register_log(
            self.index_name,
            self.partition,
            LogStart {
                active: None,
                highest_seq_no: seq_no,
                highest_durable_seq_no: seq_no,
                primary_term: primary_term.max(SINGLE_NODE_PRIMARY_TERM),
            },
        )
    }

    /// Removes every record of the partition's log, the commit marker first, because recovery removes the segments
    /// of a log without a marker and refuses a marker without its segments.
    pub(crate) fn discard(&self) -> Result<()> {
        self.restart_after(0, 0)?;
        let directory = &self.store.inner.directory;
        directory.remove(&marker_key(self.index_name, self.partition))?;
        for segment in list_segments(directory, self.index_name, self.partition)? {
            directory.remove(&segment.key)?;
        }
        directory.remove(&prepared_segment_key(self.index_name, self.partition))
    }
}
