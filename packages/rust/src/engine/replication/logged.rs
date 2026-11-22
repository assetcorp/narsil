use std::sync::Arc;

use super::{CopyPosition, ReplicatedEntry};
use crate::durability::log_segment::LogWrite;
use crate::durability::log_writer::PartitionLog;
use crate::durability::replicated_log::{AssignedRun, ReplicatedLog};
use crate::engine::index::IndexState;
use crate::error::{NarsilError, Result};

/// The log that received a call's entries, or nothing where the copy keeps no log.
pub(super) type Received = Option<Arc<PartitionLog>>;

/// The durable side of one partition of a cluster copy, which holds nothing for an engine that keeps no files.
pub(super) struct CopyLog<'a> {
    index: &'a IndexState,
    partition: u32,
}

fn runs_of<'e>(entries: impl Iterator<Item = &'e ReplicatedEntry>) -> Vec<AssignedRun> {
    let mut runs: Vec<AssignedRun> = Vec::new();
    for entry in entries {
        let write = LogWrite {
            operation: entry.operation.logged(),
            document_id: entry.document_id.clone(),
            document: entry.document.clone(),
            previous_document: entry.previous_document.clone(),
        };
        match runs.last_mut() {
            Some(run) if run.primary_term == entry.primary_term => run.writes.push(write),
            _ => runs.push(AssignedRun {
                first_seq_no: entry.seq_no,
                primary_term: entry.primary_term,
                writes: vec![write],
            }),
        }
    }
    runs
}

impl<'a> CopyLog<'a> {
    pub(super) fn of(index: &'a IndexState, partition: u32) -> CopyLog<'a> {
        CopyLog { index, partition }
    }

    fn stored(&self) -> Option<ReplicatedLog<'a>> {
        let store = self.index.log()?.log_store()?;
        Some(ReplicatedLog {
            store,
            index_name: &self.index.name,
            partition: self.partition,
        })
    }

    /// Appends `entries` while the caller holds the write lock.
    pub(super) fn append<'e>(
        &self,
        entries: impl IntoIterator<Item = &'e ReplicatedEntry>,
    ) -> Result<Received> {
        let mut entries = entries.into_iter().peekable();
        if entries.peek().is_none() {
            return Ok(None);
        }
        if let Some(stored) = self.stored() {
            return stored.append(runs_of(entries)).map(Some);
        }
        if let Some(log) = self.index.log() {
            log.count_applied(self.partition, entries.count() as u64);
        }
        Ok(None)
    }

    /// Waits until the log that received the entries holds every record up to `seq_no` on disk, once the caller
    /// releases the write lock. A failure stops this partition alone, unless another call replaced the log first.
    pub(super) fn wait_durable(&self, received: &Received, seq_no: u64) -> Result<()> {
        let (Some(stored), Some(log)) = (self.stored(), received) else {
            return Ok(());
        };
        let waited = stored.wait_durable(log, seq_no);
        if let Err(failure) = &waited {
            let _writer = self.index.write_lock();
            if !self.index.is_retired() && stored.is_current(log) {
                self.fail(failure);
            }
        }
        waited
    }

    /// Records the failure that stops the partition and moves the log past it, while the caller holds the write
    /// lock, so that a checkpoint of the other partitions goes on.
    pub(super) fn fail(&self, failure: &NarsilError) {
        let Some(copy) = self.index.replicated_copy() else {
            return;
        };
        let reached = {
            let Ok(mut held) = copy.partition(&self.index.name, self.partition) else {
                return;
            };
            held.failure.get_or_insert_with(|| failure.clone());
            held.position
        };
        let _ = self.restart_after(reached);
    }

    pub(super) fn restart_after(&self, position: CopyPosition) -> Result<()> {
        match self.stored() {
            Some(stored) => stored.restart_after(position.seq_no, position.primary_term),
            None => Ok(()),
        }
    }

    pub(super) fn discard(&self) -> Result<()> {
        match self.stored() {
            Some(stored) => stored.discard(),
            None => Ok(()),
        }
    }
}
