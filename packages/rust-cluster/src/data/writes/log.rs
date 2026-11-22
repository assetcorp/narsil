use std::collections::VecDeque;

use narsil::replication::ReplicatedEntry;

use crate::constants::{
    DEFAULT_LOG_RETENTION_BYTES, MAX_FORWARD_BATCH_OPERATIONS, MAX_WIRE_BATCH_BYTES,
    WIRE_BATCH_OVERHEAD_BYTES,
};
pub(super) use crate::payload::entry::entry_byte_estimate as entry_bytes;

fn batch_bytes(index_name: &str, entry: &ReplicatedEntry) -> u64 {
    entry_bytes(index_name, entry) + WIRE_BATCH_OVERHEAD_BYTES as u64
}

struct BatchBound<'n> {
    index_name: &'n str,
    count: usize,
    bytes: u64,
    last: Option<(u64, u64)>,
}

impl BatchBound<'_> {
    fn new(index_name: &str) -> BatchBound<'_> {
        BatchBound {
            index_name,
            count: 0,
            bytes: 0,
            last: None,
        }
    }

    fn takes(&mut self, entry: &ReplicatedEntry) -> bool {
        let bytes = batch_bytes(self.index_name, entry);
        if let Some((seq_no, primary_term)) = self.last {
            let breaks = entry.seq_no != seq_no + 1
                || entry.primary_term != primary_term
                || self.count >= MAX_FORWARD_BATCH_OPERATIONS
                || self.bytes + bytes > MAX_WIRE_BATCH_BYTES as u64;
            if breaks {
                return false;
            }
        }
        self.count += 1;
        self.bytes += bytes;
        self.last = Some((entry.seq_no, entry.primary_term));
        true
    }
}

pub(super) fn chunked<'e>(
    index_name: &str,
    entries: &'e [ReplicatedEntry],
) -> Vec<&'e [ReplicatedEntry]> {
    let mut chunks = Vec::new();
    let mut start = 0;
    let mut bound = BatchBound::new(index_name);
    for (at, entry) in entries.iter().enumerate() {
        if !bound.takes(entry) {
            chunks.push(&entries[start..at]);
            start = at;
            bound = BatchBound::new(index_name);
            bound.takes(entry);
        }
    }
    if start < entries.len() {
        chunks.push(&entries[start..]);
    }
    chunks
}

#[derive(Default)]
pub(super) struct ReplicationLog {
    entries: VecDeque<(ReplicatedEntry, u64)>,
    bytes: u64,
    commit_point: u64,
}

impl ReplicationLog {
    pub(super) fn append<'e>(
        &mut self,
        index_name: &str,
        entries: impl IntoIterator<Item = &'e ReplicatedEntry>,
    ) {
        for entry in entries {
            let follows = self
                .entries
                .back()
                .is_none_or(|(last, _)| entry.seq_no == last.seq_no + 1);
            if !follows {
                self.clear_entries();
            }
            let bytes = entry_bytes(index_name, entry);
            self.bytes += bytes;
            self.entries.push_back((entry.clone(), bytes));
        }
        while self.bytes > DEFAULT_LOG_RETENTION_BYTES {
            let Some((_, bytes)) = self.entries.pop_front() else {
                break;
            };
            self.bytes -= bytes;
        }
    }

    fn clear_entries(&mut self) {
        self.entries.clear();
        self.bytes = 0;
    }

    pub(super) fn clear(&mut self) {
        self.clear_entries();
        self.commit_point = 0;
    }

    fn offset_of(&self, seq_no: u64) -> Option<usize> {
        let (first, _) = self.entries.front()?;
        let offset = usize::try_from(seq_no.checked_sub(first.seq_no)?).ok()?;
        (offset < self.entries.len()).then_some(offset)
    }

    pub(super) fn entries_from(&self, from_seq_no: u64) -> Option<Vec<ReplicatedEntry>> {
        let skipped = self.offset_of(from_seq_no)?;
        Some(
            self.entries
                .iter()
                .skip(skipped)
                .map(|(entry, _)| entry.clone())
                .collect(),
        )
    }

    pub(super) fn retained_from(&self, from_seq_no: u64) -> Option<Vec<ReplicatedEntry>> {
        let oldest = self.oldest_seq_no()?;
        self.entries_from(from_seq_no.max(oldest))
    }

    pub(super) fn batch_from(
        &self,
        index_name: &str,
        from_seq_no: u64,
        through_seq_no: u64,
    ) -> Vec<ReplicatedEntry> {
        let Some(skipped) = self.offset_of(from_seq_no) else {
            return Vec::new();
        };
        let mut bound = BatchBound::new(index_name);
        self.entries
            .iter()
            .skip(skipped)
            .map(|(entry, _)| entry)
            .take_while(|entry| entry.seq_no <= through_seq_no && bound.takes(entry))
            .cloned()
            .collect()
    }

    pub(super) fn entry_at(&self, seq_no: u64) -> Option<&ReplicatedEntry> {
        let offset = self.offset_of(seq_no)?;
        self.entries.get(offset).map(|(entry, _)| entry)
    }

    pub(super) fn term_at(&self, seq_no: u64) -> Option<u64> {
        self.entry_at(seq_no).map(|entry| entry.primary_term)
    }

    pub(super) fn oldest_seq_no(&self) -> Option<u64> {
        self.entries.front().map(|(entry, _)| entry.seq_no)
    }

    pub(super) fn newest_seq_no(&self) -> Option<u64> {
        self.entries.back().map(|(entry, _)| entry.seq_no)
    }

    pub(super) fn commit_point(&self) -> u64 {
        self.commit_point
    }

    pub(super) fn advance_commit_point(&mut self, seq_no: u64) {
        self.commit_point = self.commit_point.max(seq_no);
    }
}
