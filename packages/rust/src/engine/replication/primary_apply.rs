use super::copy_state::ReplicatedCopy;
use super::{
    CopyPosition, EntryOperation, PrimaryLimits, PrimaryRefusal, PrimaryWrite, PrimaryWritten,
    PriorDocument, ReplicatedEntry, WriteRecord,
};
use crate::engine::EngineInner;
use crate::engine::index::IndexState;
use crate::engine::memory::reserve_for_document;
use crate::engine::writes::{
    check_primary_insert, check_primary_update, replay_delete, replay_index,
};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::value::{MAX_SAFE_INTEGER, Map, Value, decode_document, encode_document};

const ENTRY_FIXED_BYTES: u64 = 40;

pub(super) struct Candidate {
    pub(super) id: String,
    pub(super) document: Option<Map>,
    pub(super) inserts: bool,
}

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
    written_records: std::collections::HashMap<String, WriteRecord>,
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
            written_records: std::collections::HashMap::new(),
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

    fn record_of(&self, id: &str) -> Result<Option<WriteRecord>> {
        match self.written_records.get(id) {
            Some(record) => Ok(Some(*record)),
            None => Ok(self
                .copy
                .partition(&self.index.name, self.partition)?
                .record_of(id)),
        }
    }

    fn entry_bytes(&self, id: &str, document: usize, previous: usize) -> u64 {
        ENTRY_FIXED_BYTES + (self.index.name.len() + id.len() + document + previous) as u64
    }

    pub(super) fn apply(
        &mut self,
        candidate: Candidate,
    ) -> std::result::Result<PrimaryWritten, PrimaryRefusal> {
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
        let _reserved = match &document {
            Some(document) => {
                if inserts {
                    check_primary_insert(
                        index,
                        &partitions,
                        self.partition as usize,
                        &id,
                        document,
                    )?;
                } else {
                    check_primary_update(index, &partitions, &id, document)?;
                }
                let memory = &self.engine.memory;
                memory.refuse_while_full(&index.name)?;
                let replaced = (!inserts).then_some(id.as_str());
                Some(reserve_for_document(memory, index, document, replaced)?)
            }
            None if index.locate(&partitions, &id)?.is_none() => {
                return Err(index.not_found(&id).into());
            }
            None => None,
        };
        let encoded = document.as_ref().map(encode_document).transpose()?;
        let prior = match inserts {
            true => None,
            false => match index.full_document(&id)? {
                Some(held) => Some(PriorDocument {
                    document: encode_document(&held)?,
                    record: self.record_of(&id)?,
                }),
                None => None,
            },
        };
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
                replay_index(index, &id, document)?;
                EntryOperation::Index
            }
            None => {
                replay_delete(index, &id)?;
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
