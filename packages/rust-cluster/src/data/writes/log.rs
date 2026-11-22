use std::collections::VecDeque;

use narsil::replication::ReplicatedEntry;

pub(super) use crate::payload::entry::entry_byte_estimate as entry_bytes;
use crate::wire_size::{WireBatchBound, wire_batches};

fn wire_bytes(index_name: &str, entry: &ReplicatedEntry) -> usize {
    usize::try_from(entry_bytes(index_name, entry)).unwrap_or(usize::MAX)
}

fn continues(previous: &ReplicatedEntry, entry: &ReplicatedEntry) -> bool {
    entry.seq_no == previous.seq_no + 1 && entry.primary_term == previous.primary_term
}

pub(super) fn chunked<'e>(
    index_name: &str,
    entries: &'e [ReplicatedEntry],
) -> Vec<&'e [ReplicatedEntry]> {
    wire_batches(entries, |entry| wire_bytes(index_name, entry), continues)
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
        retention_bytes: u64,
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
        while self.bytes > retention_bytes {
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

    fn batch_entries<'l>(
        &'l self,
        index_name: &'l str,
        from_seq_no: u64,
        through_seq_no: u64,
    ) -> impl Iterator<Item = &'l (ReplicatedEntry, u64)> {
        let skipped = self.offset_of(from_seq_no).unwrap_or(self.entries.len());
        let mut bound = WireBatchBound::default();
        let mut previous: Option<&ReplicatedEntry> = None;
        self.entries
            .iter()
            .skip(skipped)
            .take_while(move |(entry, _)| {
                let follows = previous.is_none_or(|previous| continues(previous, entry));
                previous = Some(entry);
                entry.seq_no <= through_seq_no
                    && bound.takes(wire_bytes(index_name, entry), follows)
            })
    }

    pub(super) fn batch_from(
        &self,
        index_name: &str,
        from_seq_no: u64,
        through_seq_no: u64,
    ) -> Vec<ReplicatedEntry> {
        self.batch_entries(index_name, from_seq_no, through_seq_no)
            .map(|(entry, _)| entry.clone())
            .collect()
    }

    pub(super) fn batch_bytes(
        &self,
        index_name: &str,
        from_seq_no: u64,
        through_seq_no: u64,
    ) -> u64 {
        self.batch_entries(index_name, from_seq_no, through_seq_no)
            .map(|(_, bytes)| *bytes)
            .sum()
    }

    pub(super) fn batch_within(
        &self,
        index_name: &str,
        from_seq_no: u64,
        through_seq_no: u64,
        max_bytes: u64,
    ) -> Vec<ReplicatedEntry> {
        let mut taken: u64 = 0;
        self.batch_entries(index_name, from_seq_no, through_seq_no)
            .take_while(|(_, bytes)| {
                taken = taken.saturating_add(*bytes);
                taken <= max_bytes
            })
            .map(|(entry, _)| entry.clone())
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
