use std::collections::HashMap;

use super::copy_state::ReplicatedCopy;
use super::primary_room::PrimaryRoom;
use super::{
    CopyPosition, EntryOperation, PrimaryLimits, PrimaryRefusal, PrimaryWrite, PrimaryWritten,
    PriorDocument, ReplicatedEntry, WriteRecord,
};
use crate::engine::EngineInner;
use crate::engine::index::IndexState;
use crate::engine::writes::{
    apply_primary_insert, apply_primary_remove, apply_primary_update, replay_delete, replay_index,
};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::value::{MAX_SAFE_INTEGER, Map, Value, decode_document, encode_document};

const ENTRY_FIXED_BYTES: u64 = 40;

pub(super) struct Candidate {
    pub(super) id: String,
    pub(super) document: Option<Map>,
    pub(super) inserts: bool,
}

type Outcome = std::result::Result<PrimaryWritten, PrimaryRefusal>;

impl EngineInner {
    pub(super) fn refuse_while_memory_full_for(
        &self,
        index: &str,
        writes: &[PrimaryWrite],
    ) -> Result<()> {
        let stores = writes
            .iter()
            .any(|write| !matches!(write, PrimaryWrite::Remove { .. }));
        if stores {
            self.refuse_while_memory_full(index)?;
        }
        Ok(())
    }
}

/// Puts back what the partition held before `written`, while the caller holds the write lock.
pub(super) fn put_back(index: &IndexState, written: &PrimaryWritten) -> Result<()> {
    let id = &written.entry.document_id;
    match &written.prior {
        Some(prior) => replay_index(index, id, decode_document(&prior.document)?),
        None => replay_delete(index, id),
    }
}

/// The writes of one call on the primary, applied one after another while the caller holds the write lock.
pub(super) struct PrimaryTurn<'a> {
    engine: &'a EngineInner,
    index: &'a IndexState,
    copy: &'a ReplicatedCopy,
    partition: u32,
    limits: PrimaryLimits,
    position: CopyPosition,
    written_records: HashMap<String, WriteRecord>,
}

impl<'a> PrimaryTurn<'a> {
    pub(super) fn new(
        engine: &'a EngineInner,
        index: &'a IndexState,
        copy: &'a ReplicatedCopy,
        partition: u32,
        limits: PrimaryLimits,
    ) -> PrimaryTurn<'a> {
        PrimaryTurn {
            engine,
            index,
            copy,
            partition,
            limits,
            position: CopyPosition::default(),
            written_records: HashMap::new(),
        }
    }

    pub(super) fn start_after(&mut self, from: CopyPosition, primary_term: u64) -> Result<()> {
        if primary_term < from.primary_term.max(1) || primary_term > MAX_SAFE_INTEGER {
            return Err(NarsilError::new(
                ErrorCode::CONFIG_INVALID,
                format!(
                    "Partition {} of index \"{}\" holds entries of term {}, so it takes no write under term {primary_term}",
                    self.partition, self.index.name, from.primary_term
                ),
            )
            .with_details([
                ("indexName", Value::from(self.index.name.as_str())),
                ("partitionId", Value::from(self.partition)),
                ("primaryTerm", Value::from(primary_term)),
            ]));
        }
        self.position = CopyPosition {
            seq_no: from.seq_no,
            primary_term,
        };
        Ok(())
    }

    /// Applies each write that passes its checks and has room in memory, and returns one outcome for each write.
    pub(super) fn apply_all(
        &mut self,
        writes: Vec<std::result::Result<Candidate, PrimaryRefusal>>,
    ) -> Vec<Outcome> {
        let mut writes: Vec<Option<_>> = writes.into_iter().map(Some).collect();
        let memory = &self.engine.memory;
        let mut room = PrimaryRoom::new(memory, self.index, &writes);
        let full = memory.refuse_while_full(&self.index.name).err();
        let mut outcomes = Vec::with_capacity(writes.len());
        for at in 0..writes.len() {
            let room_made = match (&full, &writes[at]) {
                (Some(error), Some(Ok(candidate))) if candidate.document.is_some() => {
                    Err(PrimaryRefusal::Refused(error.clone()))
                }
                _ => room.reserve(at, &writes),
            };
            if let Some(checked) = writes[at].take() {
                outcomes.push(room_made.and(checked).and_then(|write| self.apply(write)));
            }
        }
        outcomes
    }

    fn record_of(&self, id: &str) -> Result<Option<WriteRecord>> {
        match self.written_records.get(id) {
            Some(record) => Ok(Some(*record)),
            None => Ok(self
                .copy
                .partition(&self.index.name, self.partition)?
                .record_of(id)),
        }
    }

    fn prior_of(&self, id: &str) -> Result<Option<PriorDocument>> {
        let Some(held) = self.index.full_document(id)? else {
            return Ok(None);
        };
        Ok(Some(PriorDocument {
            document: encode_document(&held)?,
            record: self.record_of(id)?,
        }))
    }

    fn entry_bytes(&self, id: &str, document: usize, previous: usize) -> u64 {
        ENTRY_FIXED_BYTES + (self.index.name.len() + id.len() + document + previous) as u64
    }

    fn apply(&mut self, candidate: Candidate) -> Outcome {
        let Candidate {
            id,
            document,
            inserts,
        } = candidate;
        let index = self.index;
        let partitions = index.partitions();
        if index.route(&id, partitions.len()) != self.partition as usize {
            return Err(super::copy_state::no_such_partition(&index.name, self.partition).into());
        }
        if self.position.seq_no >= MAX_SAFE_INTEGER {
            return Err(NarsilError::new(
                ErrorCode::PERSISTENCE_SAVE_FAILED,
                format!(
                    "Partition {} of index \"{}\" has run out of sequence numbers",
                    self.partition, index.name
                ),
            )
            .into());
        }
        let encoded = document.as_ref().map(encode_document).transpose()?;
        let prior = if inserts { None } else { self.prior_of(&id)? };
        let previous_document = self
            .limits
            .records_previous_documents
            .then(|| prior.as_ref().map(|held| held.document.clone()));
        let bytes = self.entry_bytes(
            &id,
            encoded.as_ref().map_or(0, Vec::len),
            previous_document
                .as_ref()
                .and_then(Option::as_ref)
                .map_or(0, Vec::len),
        );
        if bytes > self.limits.max_entry_bytes {
            return Err(PrimaryRefusal::EntryTooLarge { bytes });
        }
        let operation = match document {
            Some(document) => {
                if inserts {
                    apply_primary_insert(index, &partitions, &id, document)?;
                } else {
                    apply_primary_update(index, &partitions, &id, document)?;
                }
                EntryOperation::Index
            }
            None => {
                apply_primary_remove(index, &partitions, &id)?;
                EntryOperation::Delete
            }
        };
        self.position.seq_no += 1;
        let record = WriteRecord {
            seq_no: self.position.seq_no,
            primary_term: self.position.primary_term,
        };
        self.written_records.insert(id.clone(), record);
        Ok(PrimaryWritten {
            entry: ReplicatedEntry {
                seq_no: record.seq_no,
                primary_term: record.primary_term,
                operation,
                document_id: id,
                document: encoded,
                previous_document,
            },
            prior,
        })
    }
}
