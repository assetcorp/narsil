use std::collections::VecDeque;

use narsil::replication::ReplicatedEntry;

use crate::constants::{DEFAULT_LOG_RETENTION_BYTES, REPLICATION_ENTRY_FIXED_OVERHEAD_BYTES};

pub(super) fn entry_bytes(index_name: &str, entry: &ReplicatedEntry) -> u64 {
    let previous = match &entry.previous_document {
        Some(Some(document)) => document.len(),
        _ => 0,
    };
    let document = entry.document.as_ref().map_or(0, Vec::len);
    (REPLICATION_ENTRY_FIXED_OVERHEAD_BYTES
        + index_name.len()
        + entry.document_id.len()
        + document
        + previous) as u64
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

    pub(super) fn entries_from(&self, from_seq_no: u64) -> Option<Vec<ReplicatedEntry>> {
        let (first, _) = self.entries.front()?;
        let (last, _) = self.entries.back()?;
        if from_seq_no < first.seq_no || from_seq_no > last.seq_no {
            return None;
        }
        let skipped = usize::try_from(from_seq_no - first.seq_no).ok()?;
        Some(
            self.entries
                .iter()
                .skip(skipped)
                .map(|(entry, _)| entry.clone())
                .collect(),
        )
    }

    pub(super) fn entry_at(&self, seq_no: u64) -> Option<&ReplicatedEntry> {
        let (first, _) = self.entries.front()?;
        let offset = usize::try_from(seq_no.checked_sub(first.seq_no)?).ok()?;
        self.entries.get(offset).map(|(entry, _)| entry)
    }

    pub(super) fn term_at(&self, seq_no: u64) -> Option<u64> {
        self.entry_at(seq_no).map(|entry| entry.primary_term)
    }

    pub(super) fn oldest_seq_no(&self) -> Option<u64> {
        self.entries.front().map(|(entry, _)| entry.seq_no)
    }

    pub(super) fn advance_commit_point(&mut self, seq_no: u64) {
        self.commit_point = self.commit_point.max(seq_no);
    }
}
