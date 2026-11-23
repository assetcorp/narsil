use crate::engine::sync::feed::{SyncCursor, SyncEntry, SyncRead};
use crate::engine::sync::source::{
    BoundsFreshness, ChangeSource, ChangesIndexState, DocumentTest,
};
use crate::error::Result;
use crate::format::wal::decode_entry;

use super::derive::{change_of, filtered_change};
use super::open::{not_enabled, previous_document_required};
use super::types::{ChangeGroup, ResyncReason};

pub(super) struct Following {
    epoch: String,
    test: Option<DocumentTest>,
    cursors: Vec<SyncCursor>,
    heads: Vec<u64>,
    turn: usize,
}

pub(super) enum Step {
    Group(ChangeGroup),
    Resync(ResyncReason),
    Idle,
}

impl Following {
    pub(super) fn new(
        epoch: String,
        test: Option<DocumentTest>,
        starts: &[u64],
        heads: Vec<u64>,
    ) -> Following {
        Following {
            epoch,
            test,
            cursors: starts
                .iter()
                .enumerate()
                .map(|(partition_id, start)| SyncCursor::after(partition_id as u32, *start))
                .collect(),
            heads,
            turn: 0,
        }
    }

    /// Moves the cursor of `partition` back to `seq_no`, so that the next read of the partition returns the entries
    /// above it again, and leaves a cursor at or below `seq_no` as it stands.
    pub(super) fn rewind(&mut self, partition: usize, seq_no: u64) {
        if let Some(cursor) = self.cursors.get_mut(partition)
            && seq_no < cursor.position()
        {
            *cursor = SyncCursor::after(partition as u32, seq_no);
        }
    }

    fn caught_up(&self) -> bool {
        self.cursors
            .iter()
            .zip(&self.heads)
            .all(|(cursor, head)| cursor.position() >= *head)
    }

    fn verdict(
        &self,
        index_name: &str,
        state: Option<ChangesIndexState>,
    ) -> Result<Option<ResyncReason>> {
        let Some(state) = state else {
            return Err(not_enabled(index_name));
        };
        if state.epoch != self.epoch || state.partition_count as usize != self.cursors.len() {
            return Ok(Some(ResyncReason::Epoch));
        }
        if self.test.is_some() && !state.previous_document {
            return Err(previous_document_required(index_name));
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

    fn group(&self, partition: usize, entries: Vec<SyncEntry>) -> Result<Option<ChangeGroup>> {
        let Some(scanned_seq_no) = entries.last().map(|entry| entry.seq_no) else {
            return Ok(None);
        };
        let scanned_bytes = entries
            .iter()
            .map(|entry| entry.payload.len() as u64)
            .sum();
        let mut changes = Vec::with_capacity(entries.len());
        for entry in entries {
            let entry = decode_entry(&entry.payload)?;
            let holds_previous = entry.previous_document.is_some();
            let change = change_of(entry)?;
            match &self.test {
                None => changes.push(change),
                Some(test) => changes.extend(filtered_change(change, holds_previous, test)?),
            }
        }
        Ok(Some(ChangeGroup {
            partition_id: partition as u32,
            changes,
            scanned_seq_no,
            scanned_bytes,
        }))
    }
}

pub(super) fn step(
    source: &dyn ChangeSource,
    index_name: &str,
    following: &mut Following,
    budget_bytes: usize,
) -> Result<Step> {
    if source.index_resting(index_name)? && following.caught_up() {
        return Ok(Step::Idle);
    }
    if let Some(reason) = following.verdict(index_name, source.changes_state(index_name)?)? {
        return Ok(Step::Resync(reason));
    }
    for (partition_id, head) in following.heads.iter_mut().enumerate() {
        *head = source
            .bounds(index_name, partition_id as u32, BoundsFreshness::Recent)?
            .head;
    }
    let Some(partition) = following.next_partition() else {
        return Ok(Step::Idle);
    };
    let before = following.cursors[partition].position();
    let up_to = following.heads[partition];
    let read = source.read(
        index_name,
        &mut following.cursors[partition],
        up_to,
        budget_bytes,
    )?;
    if source.index_resting(index_name)? {
        following.cursors[partition] = SyncCursor::after(partition as u32, before);
        return Ok(Step::Idle);
    }
    if let Some(reason) = following.verdict(index_name, source.changes_state(index_name)?)? {
        return Ok(Step::Resync(reason));
    }
    let entries = match read {
        SyncRead::HistoryGone => return Ok(Step::Resync(ResyncReason::History)),
        SyncRead::Entries(entries) => entries,
    };
    Ok(match following.group(partition, entries)? {
        Some(group) => Step::Group(group),
        None => Step::Idle,
    })
}
