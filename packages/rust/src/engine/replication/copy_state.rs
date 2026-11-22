use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use super::{CopyPosition, HeldTerm, WriteRecord};
use crate::engine::index::IndexState;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::keyword_segment::{KeywordSegment, WriteRecords};
use crate::format::manifest::{PartitionCheckpoint, TermStart};
use crate::format::wal::{LogEntry, Operation};
use crate::index::segment::{SegmentData, SegmentEntry};
use crate::util::bytes::offset_entry;
use crate::value::Value;

#[derive(Debug, Clone, Default)]
pub(crate) struct PartitionCopy {
    pub(crate) position: CopyPosition,
    history: Vec<TermStart>,
    records: HashMap<String, WriteRecord>,
    pub(crate) failure: Option<NarsilError>,
}

impl PartitionCopy {
    pub(crate) fn note(&mut self, operation: Operation, document_id: &str, record: WriteRecord) {
        match operation {
            Operation::Delete => {
                self.records.remove(document_id);
            }
            Operation::Index => match self.records.get_mut(document_id) {
                Some(held) => *held = record,
                None => {
                    self.records.insert(document_id.to_string(), record);
                }
            },
        }
        self.reach(CopyPosition {
            seq_no: record.seq_no,
            primary_term: record.primary_term,
        });
    }

    pub(crate) fn reach(&mut self, position: CopyPosition) {
        let opens_term = self
            .history
            .last()
            .is_none_or(|last| position.primary_term > last.primary_term);
        if opens_term {
            self.history.push(TermStart {
                primary_term: position.primary_term,
                first_seq_no: position.seq_no,
            });
        }
        self.position = position;
    }

    pub(crate) fn record_of(&self, document_id: &str) -> Option<WriteRecord> {
        self.records.get(document_id).copied()
    }

    pub(crate) fn held_term(&self, seq_no: u64) -> HeldTerm {
        if seq_no > self.position.seq_no {
            return HeldTerm::Absent;
        }
        if seq_no == 0 {
            return HeldTerm::Held(0);
        }
        if seq_no == self.position.seq_no {
            return HeldTerm::Held(self.position.primary_term);
        }
        let after = self
            .history
            .partition_point(|start| start.first_seq_no <= seq_no);
        match after.checked_sub(1).and_then(|at| self.history.get(at)) {
            Some(start) => HeldTerm::Held(start.primary_term),
            None => HeldTerm::Uncovered,
        }
    }
}

/// What an index records as a cluster copy beside its documents: its UUID, the partitions that the node holds,
/// and the position, term history, and write records of each partition. A standalone index holds none of it.
pub(crate) struct ReplicatedCopy {
    pub(crate) uuid: String,
    held: Mutex<Option<Vec<u32>>>,
    partitions: Vec<Mutex<PartitionCopy>>,
}

fn guarded<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(super) fn no_such_partition(index: &str, partition: u32) -> NarsilError {
    NarsilError::new(
        ErrorCode::CONFIG_INVALID,
        format!("Index \"{index}\" holds no copy of partition {partition}"),
    )
    .with_details([
        ("indexName", Value::from(index)),
        ("partitionId", Value::from(partition)),
    ])
}

fn empty_records(count: usize) -> WriteRecords {
    WriteRecords {
        seq_nos: Vec::with_capacity(count),
        primary_terms: Vec::with_capacity(count),
    }
}

fn save_record(saved: &mut WriteRecords, record: Option<WriteRecord>) {
    saved.seq_nos.push(record.map_or(0, |held| held.seq_no));
    saved
        .primary_terms
        .push(record.map_or(0, |held| held.primary_term));
}

fn saved_record(entry: &SegmentEntry, ordinal: u32) -> Result<Option<WriteRecord>> {
    let SegmentData::Frozen(segment) = &entry.data else {
        return Ok(None);
    };
    let saved = match &segment.paged {
        Some(paged) => paged.write_record(ordinal)?,
        None => segment.payload.write_records.as_ref().and_then(|records| {
            let at = ordinal as usize;
            Some((*records.seq_nos.get(at)?, *records.primary_terms.get(at)?))
        }),
    };
    Ok(saved
        .filter(|(seq_no, _)| *seq_no > 0)
        .map(|(seq_no, primary_term)| WriteRecord {
            seq_no,
            primary_term,
        }))
}

impl ReplicatedCopy {
    pub(crate) fn new(
        uuid: String,
        held: Option<Vec<u32>>,
        partitions: Vec<PartitionCopy>,
    ) -> Self {
        ReplicatedCopy {
            uuid,
            held: Mutex::new(held),
            partitions: partitions.into_iter().map(Mutex::new).collect(),
        }
    }

    /// Returns the copy that `checkpoint` and the segments loaded from it record, which recovery extends with each
    /// entry that it replays.
    pub(crate) fn loaded(
        index: &IndexState,
        uuid: String,
        held: Option<Vec<u32>>,
        checkpoint: &[PartitionCheckpoint],
    ) -> Result<ReplicatedCopy> {
        let partitions = index.partitions();
        let mut copies = Vec::with_capacity(partitions.len());
        for (at, partition) in partitions.iter().enumerate() {
            let mut copy = PartitionCopy::default();
            let covered = checkpoint
                .iter()
                .find(|entry| entry.partition_id as usize == at)
                .filter(|entry| entry.last_seq_no > 0);
            if let Some(covered) = covered {
                copy.position = CopyPosition {
                    seq_no: covered.last_seq_no,
                    primary_term: covered.primary_term,
                };
                copy.history = covered.term_history.clone().unwrap_or_default();
            }
            let snapshot = partition.snapshot();
            for entry in &snapshot.segments {
                for ordinal in entry.live_ordinals() {
                    if let Some(record) = saved_record(entry, ordinal)? {
                        let id = entry.id_of(ordinal)?.into_owned();
                        copy.records.insert(id, record);
                    }
                }
            }
            copies.push(copy);
        }
        Ok(ReplicatedCopy::new(uuid, held, copies))
    }

    pub(crate) fn partition(
        &self,
        index: &str,
        partition: u32,
    ) -> Result<MutexGuard<'_, PartitionCopy>> {
        self.partitions
            .get(partition as usize)
            .map(guarded)
            .ok_or_else(|| no_such_partition(index, partition))
    }

    pub(crate) fn partition_count(&self) -> usize {
        self.partitions.len()
    }

    pub(crate) fn held(&self) -> Option<Vec<u32>> {
        guarded(&self.held).clone()
    }

    pub(crate) fn hold(&self, held: Vec<u32>) {
        *guarded(&self.held) = Some(held);
    }

    pub(crate) fn replayed(&self, partition: u32, entry: &LogEntry) {
        let Some(held) = self.partitions.get(partition as usize) else {
            return;
        };
        let record = WriteRecord {
            seq_no: entry.seq_no as u64,
            primary_term: entry.primary_term as u64,
        };
        guarded(held).note(entry.operation, &entry.document_id, record);
    }

    /// Returns what a checkpoint records for a partition whose write-ahead log reaches `logged`, or zero where the
    /// engine keeps no such log, with the term history that the copy holds up to that position.
    pub(crate) fn checkpointed(&self, partition: u32, logged: u64) -> Option<PartitionCheckpoint> {
        let copy = guarded(self.partitions.get(partition as usize)?);
        Some(PartitionCheckpoint {
            partition_id: partition,
            last_seq_no: copy.position.seq_no.max(logged),
            primary_term: copy.position.primary_term.max(1),
            term_history: (!copy.history.is_empty()).then(|| copy.history.clone()),
        })
    }

    /// Returns the write record of each document of a segment payload, zero where the copy holds none.
    pub(crate) fn records_of(
        &self,
        partition: u32,
        payload: &KeywordSegment,
    ) -> Option<WriteRecords> {
        let copy = guarded(self.partitions.get(partition as usize)?);
        let count = payload.document_count as usize;
        let mut saved = empty_records(count);
        for at in 0..count {
            let id = offset_entry(&payload.ids, &payload.id_offsets, at);
            let record = std::str::from_utf8(id)
                .ok()
                .and_then(|id| copy.record_of(id));
            save_record(&mut saved, record);
        }
        Some(saved)
    }

    /// Returns the write record of each live document of `entries`, in the order in which a merge numbers them.
    /// The partition's state stays unlocked while an ID is read from a file.
    pub(crate) fn records_of_live(
        &self,
        partition: u32,
        entries: &[SegmentEntry],
    ) -> Result<Option<WriteRecords>> {
        let Some(held) = self.partitions.get(partition as usize) else {
            return Ok(None);
        };
        let mut saved = empty_records(0);
        for entry in entries {
            for ordinal in entry.live_ordinals() {
                let id = entry.id_of(ordinal)?;
                save_record(&mut saved, guarded(held).record_of(&id));
            }
        }
        Ok(Some(saved))
    }
}
