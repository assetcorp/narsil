use std::sync::Arc;

use crate::durability::change_reader::{LogCursor, LogRead};
use crate::engine::EngineInner;
use crate::engine::index::IndexState;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::wal::LogEntry;

use super::constants::CHANGE_READ_CHUNK_BYTES;
use super::derive::{change_of, filtered_change};
use super::filter::ChangeFilter;
use super::open::{log_store_for_changes, not_enabled, previous_document_required};
use super::types::{ChangeGroup, ResyncReason};

pub(super) struct Following {
    epoch: String,
    filter: Option<ChangeFilter>,
    cursors: Vec<LogCursor>,
    heads: Vec<u64>,
    turn: usize,
}

pub(super) enum Step {
    Group(ChangeGroup),
    Resync(ResyncReason),
    Idle,
}

fn index_not_found(index_name: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::INDEX_NOT_FOUND,
        format!("Index \"{index_name}\" does not exist"),
    )
}

impl Following {
    pub(super) fn new(
        epoch: String,
        filter: Option<ChangeFilter>,
        starts: &[u64],
        heads: Vec<u64>,
    ) -> Following {
        Following {
            epoch,
            filter,
            cursors: starts
                .iter()
                .map(|start| LogCursor::after(*start))
                .collect(),
            heads,
            turn: 0,
        }
    }

    fn caught_up(&self) -> bool {
        self.cursors
            .iter()
            .zip(&self.heads)
            .all(|(cursor, head)| cursor.position() >= *head)
    }

    fn verdict(&self, index: &IndexState) -> Result<Option<ResyncReason>> {
        let Some(log) = index.log() else {
            return Err(not_enabled(&index.name));
        };
        let (Some(epoch), records_previous) = log.recorded_capture() else {
            return Err(not_enabled(&index.name));
        };
        if epoch != self.epoch || index.partitions().len() != self.cursors.len() {
            return Ok(Some(ResyncReason::Epoch));
        }
        if self.filter.is_some() && !records_previous {
            return Err(previous_document_required(&index.name));
        }
        Ok(None)
    }

    fn next_partition(&mut self) -> Option<usize> {
        let count = self.cursors.len();
        let found = (0..count)
            .map(|offset| (self.turn + offset) % count)
            .find(|at| self.cursors[*at].position() < self.heads[*at])?;
        self.turn = (found + 1) % count;
        Some(found)
    }

    fn group(
        &self,
        engine: &EngineInner,
        index: &IndexState,
        partition: usize,
        entries: Vec<LogEntry>,
    ) -> Result<Option<ChangeGroup>> {
        let Some(scanned_seq_no) = entries.last().map(|entry| entry.seq_no as u64) else {
            return Ok(None);
        };
        let mut changes = Vec::with_capacity(entries.len());
        for entry in entries {
            let holds_previous = entry.previous_document.is_some();
            let change = change_of(entry)?;
            match &self.filter {
                None => changes.push(change),
                Some(filter) => {
                    let matches =
                        |document: &_| filter.matches(index, &engine.search_limits, document);
                    changes.extend(filtered_change(change, holds_previous, &matches)?);
                }
            }
        }
        Ok(Some(ChangeGroup {
            partition_id: partition as u32,
            changes,
            scanned_seq_no,
        }))
    }
}

fn reach(
    engine: &EngineInner,
    index_name: &str,
    caught_up: bool,
) -> Result<Option<Arc<IndexState>>> {
    if let Some(index) = engine.open_index_named(index_name) {
        return Ok(Some(index));
    }
    if !engine.holds_index(index_name) {
        return Err(index_not_found(index_name));
    }
    if caught_up {
        return Ok(None);
    }
    engine.open_index(index_name).map(Some)
}

pub(super) fn step(
    engine: &EngineInner,
    index_name: &str,
    following: &mut Following,
) -> Result<Step> {
    engine.guard_shutdown()?;
    let Some(index) = reach(engine, index_name, following.caught_up())? else {
        return Ok(Step::Idle);
    };
    if let Some(reason) = following.verdict(&index)? {
        return Ok(Step::Resync(reason));
    }
    let store = log_store_for_changes(&index)?;
    for (partition_id, head) in following.heads.iter_mut().enumerate() {
        *head = store.log_head(index_name, partition_id as u32)?;
    }
    drop(index);
    let Some(partition) = following.next_partition() else {
        return Ok(Step::Idle);
    };
    let before = following.cursors[partition].position();
    let up_to = following.heads[partition];
    let read = store.read_log_entries(
        index_name,
        partition as u32,
        &mut following.cursors[partition],
        up_to,
        CHANGE_READ_CHUNK_BYTES,
    )?;
    let Some(current) = engine.open_index_named(index_name) else {
        following.cursors[partition] = LogCursor::after(before);
        return Ok(Step::Idle);
    };
    if let Some(reason) = following.verdict(&current)? {
        return Ok(Step::Resync(reason));
    }
    let entries = match read {
        LogRead::HistoryGone => return Ok(Step::Resync(ResyncReason::History)),
        LogRead::Entries(entries) => entries,
    };
    Ok(
        match following.group(engine, &current, partition, entries)? {
            Some(group) => Step::Group(group),
            None => Step::Idle,
        },
    )
}
