use super::logged::CopyLog;
use super::primary_apply::{Candidate, PrimaryTurn, put_back};
use super::{
    PartitionCopies, PrimaryLimits, PrimaryRefusal, PrimaryRun, PrimaryWrite, ReplicatedEntry,
    WriteRecord,
};
use crate::config::validate_doc_id;
use crate::engine::index::IndexState;
use crate::engine::vectors::HeldChunk;
use crate::engine::writes::{check_primary_document, require_matching_doc_id};
use crate::error::Result;
use crate::index::partition::in_keyword_batch;
use crate::schema::require_document_within_size_limit;
use crate::value::Map;

enum Slot {
    Document { id: String, inserts: bool },
    Remove { id: String },
}

fn prepared(
    index: &IndexState,
    writes: Vec<PrimaryWrite>,
) -> Vec<std::result::Result<Candidate, PrimaryRefusal>> {
    let mut slots = Vec::with_capacity(writes.len());
    let mut documents: Vec<Map> = Vec::new();
    let mut refusals: Vec<Option<PrimaryRefusal>> = Vec::with_capacity(writes.len());
    for write in writes {
        let mut checked = validate_doc_id(write.document_id());
        let slot = match write {
            PrimaryWrite::Remove { document_id } => Slot::Remove { id: document_id },
            PrimaryWrite::Insert {
                document_id,
                document,
            } => {
                checked = checked
                    .and_then(|()| require_matching_doc_id(&document_id, &document))
                    .and_then(|()| check_primary_document(index, &document));
                documents.push(document);
                Slot::Document {
                    id: document_id,
                    inserts: true,
                }
            }
            PrimaryWrite::Update {
                document_id,
                document,
            } => {
                checked = checked
                    .and_then(|()| require_matching_doc_id(&document_id, &document))
                    .and_then(|()| check_primary_document(index, &document));
                documents.push(document);
                Slot::Document {
                    id: document_id,
                    inserts: false,
                }
            }
        };
        refusals.push(checked.err().map(PrimaryRefusal::from));
        slots.push(slot);
    }
    let documents_at: Vec<usize> = slots
        .iter()
        .enumerate()
        .filter_map(|(at, slot)| matches!(slot, Slot::Document { .. }).then_some(at))
        .collect();
    let mut refused: Vec<bool> = documents_at
        .iter()
        .map(|&at| refusals[at].is_some())
        .collect();
    let mut chunk = HeldChunk::new(documents);
    let embedding = index
        .vectors
        .embed_held_chunk(&index.name, &mut chunk, &mut refused);
    for (at, error) in embedding.lasting.into_iter().chain(embedding.embedded) {
        if let Some(&slot) = documents_at.get(at) {
            refusals[slot].get_or_insert(error.into());
        }
    }
    let mut embedded = chunk.take().into_iter();
    slots
        .into_iter()
        .zip(refusals)
        .map(|(slot, refusal)| {
            let candidate = match slot {
                Slot::Remove { id } => Candidate {
                    id,
                    document: None,
                    inserts: false,
                },
                Slot::Document { id, inserts } => Candidate {
                    id,
                    document: embedded.next(),
                    inserts,
                },
            };
            if let Some(refusal) = refusal {
                return Err(refusal);
            }
            if let Some(document) = &candidate.document {
                require_document_within_size_limit(document)?;
            }
            Ok(candidate)
        })
        .collect()
}

impl PartitionCopies<'_> {
    /// Applies a primary's writes to its copy of one partition, numbers each write that applies after the copy's
    /// last entry under `primary_term`, and appends them to the write-ahead log, returning once they are durable
    /// under the engine's durability mode.
    ///
    /// The engine embeds each document once before it takes the write lock, and it refuses each bad write alone.
    /// Where the log refuses the writes, the copy puts back what it held before them, and the partition takes no
    /// entry until it is replaced.
    pub fn write(
        &self,
        index: &str,
        partition: u32,
        primary_term: u64,
        writes: Vec<PrimaryWrite>,
        limits: PrimaryLimits,
    ) -> Result<PrimaryRun> {
        self.engine.refuse_while_memory_full_for(index, &writes)?;
        let writable = self.engine.writable_index(index)?;
        let state = writable.index();
        let candidates = prepared(state, writes);
        let log = CopyLog::of(state, partition);
        let (mut outcomes, reached, logged) = {
            let _writer = state.lock_writes()?;
            let copy = super::copy_of(state)?;
            let from = {
                let held = copy.partition(&state.name, partition)?;
                if let Some(failure) = &held.failure {
                    return Err(failure.clone());
                }
                held.position
            };
            let mut turn = PrimaryTurn::new(self.engine, state, copy, partition, limits);
            turn.start_after(from, primary_term)?;
            let mut outcomes = Vec::new();
            let closed = in_keyword_batch(&state.partitions(), || {
                outcomes = turn.apply_all(candidates);
                Ok(())
            });
            let entries: Vec<&ReplicatedEntry> = outcomes
                .iter()
                .flatten()
                .map(|written| &written.entry)
                .collect();
            let reached = entries.last().map(|entry| entry.seq_no);
            let logged = closed.and_then(|()| log.append(entries.iter().copied()));
            match &logged {
                Ok(_) => {
                    let mut held = copy.partition(&state.name, partition)?;
                    for entry in &entries {
                        let record = WriteRecord {
                            seq_no: entry.seq_no,
                            primary_term: entry.primary_term,
                        };
                        held.note(entry.operation.logged(), &entry.document_id, record);
                    }
                }
                Err(failure) => {
                    log.fail(failure);
                    for written in outcomes.iter().rev().flatten() {
                        put_back(state, written)?;
                    }
                }
            }
            (outcomes, reached, logged)
        };
        self.engine.after_write(state);
        let Some(reached) = reached else {
            return Ok(PrimaryRun {
                outcomes,
                failure: logged.err(),
            });
        };
        self.engine.events.wrote(&state.name);
        self.engine.events.check_watermark(state);
        let failure = match logged {
            Ok(received) => log.wait_durable(&received, reached).err(),
            Err(failure) => {
                for outcome in &mut outcomes {
                    if outcome.is_ok() {
                        *outcome = Err(PrimaryRefusal::Refused(failure.clone()));
                    }
                }
                Some(failure)
            }
        };
        let released = outcomes
            .iter()
            .flatten()
            .any(|written| written.entry.document.is_none());
        if released {
            self.engine.memory.memory_released();
        }
        Ok(PrimaryRun { outcomes, failure })
    }
}
