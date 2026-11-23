use narsil::{
    BoundsFreshness, ChangePosition, ChangeSource, ErrorCode, NarsilError, SyncBounds, SyncCursor,
    SyncEntry, SyncFeedState, SyncRead,
};

use super::SyncFeed;
use crate::feeds::constants::ENTRIES_MESSAGE_LIMIT_BYTES;
use crate::feeds::core::Core;
use crate::feeds::hub::SYNC_OFF_REASON;
use crate::feeds::wire::{CLOSE_RESYNC, entries_message};

pub(super) enum Opened {
    Subscribed {
        heads: Vec<u64>,
        bytes_behind: u64,
        snapshot_bytes: u64,
    },
    Resync(&'static str),
}

struct Read {
    cursor: SyncCursor,
    entries: Result<SyncRead, NarsilError>,
    current: Result<Option<SyncFeedState>, NarsilError>,
}

pub(super) fn state_of(
    source: &dyn ChangeSource,
    index: &str,
) -> Result<Option<SyncFeedState>, NarsilError> {
    match source.index_state(index) {
        Err(error) if error.code() == ErrorCode::INDEX_NOT_FOUND => Ok(None),
        other => other,
    }
}

pub(super) fn bounds_of(
    source: &dyn ChangeSource,
    index: &str,
    count: usize,
    freshness: BoundsFreshness,
) -> Result<Vec<SyncBounds>, NarsilError> {
    (0..count as u32)
        .map(|partition| source.bounds(index, partition, freshness))
        .collect()
}

pub(super) fn open(
    source: &dyn ChangeSource,
    index: &str,
    epoch: &str,
    seq_nos: &[u64],
) -> Result<Opened, NarsilError> {
    let mut heads = Vec::with_capacity(seq_nos.len());
    for (partition, seq_no) in seq_nos.iter().enumerate() {
        let bounds = source.bounds(index, partition as u32, BoundsFreshness::Current)?;
        if *seq_no < bounds.oldest_seq_no.saturating_sub(1) {
            return Ok(Opened::Resync("history"));
        }
        if *seq_no > bounds.highest_seq_no {
            return Ok(Opened::Resync("ahead"));
        }
        heads.push(bounds.head);
    }
    let positions: Vec<ChangePosition> = seq_nos
        .iter()
        .enumerate()
        .map(|(partition, seq_no)| ChangePosition {
            partition_id: partition as u32,
            seq_no: *seq_no,
        })
        .collect();
    let bytes_behind = source.bytes_behind(index, &positions)?;
    let snapshot_bytes = source.snapshot_bytes(index)?;
    if state_of(source, index)?.is_none_or(|state| state.epoch != epoch) {
        return Ok(Opened::Resync("epoch"));
    }
    Ok(Opened::Subscribed {
        heads,
        bytes_behind,
        snapshot_bytes,
    })
}

impl SyncFeed {
    pub(super) async fn send_behind(&mut self, core: &mut Core) {
        let mut progressed = true;
        while progressed && !core.closed() {
            progressed = false;
            for partition in 0..self.heads.len() {
                let behind = match (self.sent.get(partition), self.heads.get(partition)) {
                    (Some(sent), Some(head)) => sent < head,
                    _ => false,
                };
                if core.closed() || !behind {
                    continue;
                }
                match self.send_partition(core, partition).await {
                    Some(true) => progressed = true,
                    Some(false) => {}
                    None => return,
                }
            }
        }
    }

    async fn send_partition(&mut self, core: &mut Core, partition: usize) -> Option<bool> {
        let window = self.window.as_ref()?;
        if !window.allows(1) || core.outbox.has_charge() {
            return None;
        }
        let max_bytes = window.room().clamp(1, ENTRIES_MESSAGE_LIMIT_BYTES) as usize;
        let after = *self.sent.get(partition)?;
        let up_to = *self.heads.get(partition)?;
        let cursor = match self.cursors.get_mut(partition)?.take() {
            Some(cursor) if cursor.position() == after => cursor,
            _ => SyncCursor::after(partition as u32, after),
        };
        let index = core.index.clone();
        let read = core
            .catch_up(move |source| {
                let mut cursor = cursor;
                let entries = source.read(&index, &mut cursor, up_to, max_bytes);
                let current = state_of(source, &index);
                Read {
                    cursor,
                    entries,
                    current,
                }
            })
            .await?;
        if core.closed() || !self.same_epoch(core, read.current) {
            return None;
        }
        let entries: Vec<SyncEntry> = match read.entries {
            Ok(SyncRead::Entries(entries)) => entries,
            Ok(SyncRead::HistoryGone) => {
                core.resync("history");
                return None;
            }
            Err(error) => {
                core.fail(&error, SYNC_OFF_REASON);
                return None;
            }
        };
        let entries: Vec<SyncEntry> = entries
            .into_iter()
            .filter(|entry| entry.seq_no > after)
            .collect();
        let Some(last) = entries.last().map(|entry| entry.seq_no) else {
            self.keep_cursor(partition, read.cursor);
            return Some(false);
        };
        let bytes: u64 = entries.iter().map(|entry| entry.payload.len() as u64).sum();
        let window = self.window.as_mut()?;
        if !window.allows(bytes) {
            return None;
        }
        let payloads: Vec<&[u8]> = entries
            .iter()
            .map(|entry| entry.payload.as_slice())
            .collect();
        let Some(message) = entries_message(partition as u32, &payloads) else {
            core.fail_quietly();
            return None;
        };
        if !core.outbox.charge(message.len() as u64) {
            return None;
        }
        for entry in &entries {
            window.record(partition, entry.seq_no, entry.payload.len() as u64);
        }
        if let Some(sent) = self.sent.get_mut(partition) {
            *sent = last;
        }
        self.keep_cursor(partition, read.cursor);
        core.outbox.send(message);
        Some(true)
    }

    fn keep_cursor(&mut self, partition: usize, cursor: SyncCursor) {
        if let Some(slot) = self.cursors.get_mut(partition) {
            *slot = Some(cursor);
        }
    }

    pub(super) fn same_epoch(
        &self,
        core: &mut Core,
        current: Result<Option<SyncFeedState>, NarsilError>,
    ) -> bool {
        match current {
            Ok(Some(state)) if state.epoch == self.epoch => true,
            Ok(Some(_)) => {
                core.resync("epoch");
                false
            }
            Ok(None) => {
                core.close(CLOSE_RESYNC, SYNC_OFF_REASON);
                false
            }
            Err(error) => {
                core.fail(&error, SYNC_OFF_REASON);
                false
            }
        }
    }
}
