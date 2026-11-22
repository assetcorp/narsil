use super::logged::CopyLog;
use super::{
    AppliedRun, CopyPosition, EntryOperation, PartitionCopies, ReplicatedEntry, WriteRecord,
};
use crate::engine::durable::load::restore_vector_bytes;
use crate::engine::index::IndexState;
use crate::engine::writes::{check_replicated_document, replay_delete, replay_index};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::index::partition::in_keyword_batch;
use crate::value::{MAX_SAFE_INTEGER, Map, Value, decode_document};

fn unfit(index: &IndexState, entry: &ReplicatedEntry, why: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::DOC_VALIDATION_FAILED,
        format!(
            "Entry {} of document \"{}\" {why}, so the copy cannot apply it",
            entry.seq_no, entry.document_id
        ),
    )
    .with_details([
        ("indexName", Value::from(index.name.as_str())),
        ("docId", Value::from(entry.document_id.as_str())),
        ("seqNo", Value::from(entry.seq_no)),
    ])
}

fn applicable(
    index: &IndexState,
    partition: u32,
    after: CopyPosition,
    entry: &ReplicatedEntry,
) -> Result<Option<Map>> {
    if entry.seq_no != after.seq_no.saturating_add(1) || entry.seq_no > MAX_SAFE_INTEGER {
        return Err(unfit(index, entry, "does not follow the copy's last entry"));
    }
    if entry.primary_term < after.primary_term.max(1) || entry.primary_term > MAX_SAFE_INTEGER {
        return Err(unfit(
            index,
            entry,
            "carries a term that the log cannot take",
        ));
    }
    if index.route(&entry.document_id, index.partitions().len()) != partition as usize {
        return Err(unfit(index, entry, "belongs to another partition"));
    }
    match (entry.operation, &entry.document) {
        (EntryOperation::Delete, None) => Ok(None),
        (EntryOperation::Index, Some(bytes)) => {
            let mut document = decode_document(bytes)?;
            restore_vector_bytes(index, &mut document)?;
            check_replicated_document(index, &document)?;
            Ok(Some(document))
        }
        _ => Err(unfit(index, entry, "does not fit its operation")),
    }
}

fn apply(index: &IndexState, id: &str, document: Option<Map>) -> Result<()> {
    match document {
        Some(document) => replay_index(index, id, document),
        None => replay_delete(index, id),
    }
}

struct Applied {
    count: usize,
    position: CopyPosition,
    failure: Option<NarsilError>,
    unsettled: Option<NarsilError>,
}

fn apply_run(
    index: &IndexState,
    partition: u32,
    from: CopyPosition,
    entries: &[ReplicatedEntry],
) -> Applied {
    let mut applied = Applied {
        count: 0,
        position: from,
        failure: None,
        unsettled: None,
    };
    let closed = in_keyword_batch(&index.partitions(), || {
        for entry in entries {
            let outcome = applicable(index, partition, applied.position, entry)
                .and_then(|document| apply(index, &entry.document_id, document));
            if let Err(failure) = outcome {
                applied.failure = Some(failure);
                break;
            }
            applied.count += 1;
            applied.position = CopyPosition {
                seq_no: entry.seq_no,
                primary_term: entry.primary_term,
            };
        }
        Ok(())
    });
    applied.unsettled = closed.err();
    applied
}

impl PartitionCopies<'_> {
    /// Applies the entries of one partition in order, and appends each one to the write-ahead log with the
    /// sequence number and the term that the primary assigned, returning once they are durable under the engine's
    /// durability mode.
    ///
    /// The run stops at the first entry that the copy cannot apply and keeps the entries before it, as
    /// [`AppliedRun`] reports. That entry, like a log failure, fails this partition alone, and the partition then
    /// takes no entry until [`PartitionCopies::empty_partition`] or [`PartitionCopies::reload_partition`] replaces
    /// it.
    pub fn append(
        &self,
        index: &str,
        partition: u32,
        entries: &[ReplicatedEntry],
    ) -> Result<AppliedRun> {
        let writable = self.engine.writable_index(index)?;
        let state = writable.index();
        let log = CopyLog::of(state, partition);
        let (applied, logged) = {
            let _writer = state.lock_writes()?;
            let copy = super::copy_of(state)?;
            let from = {
                let held = copy.partition(&state.name, partition)?;
                if let Some(failure) = &held.failure {
                    return Ok(AppliedRun {
                        applied: 0,
                        failure: Some(failure.clone()),
                    });
                }
                held.position
            };
            let applied = apply_run(state, partition, from, entries);
            let taken = &entries[..applied.count];
            let logged = log
                .append(taken)
                .and_then(|received| match &applied.unsettled {
                    Some(failure) => Err(failure.clone()),
                    None => Ok(received),
                });
            {
                let mut held = copy.partition(&state.name, partition)?;
                for entry in taken {
                    let record = WriteRecord {
                        seq_no: entry.seq_no,
                        primary_term: entry.primary_term,
                    };
                    held.note(entry.operation.logged(), &entry.document_id, record);
                }
                if let (Ok(_), Some(failure)) = (&logged, &applied.failure) {
                    held.failure.get_or_insert_with(|| failure.clone());
                }
            }
            if let Err(failure) = &logged {
                log.fail(failure);
            }
            (applied, logged)
        };
        self.engine.after_write(state);
        if applied.count == 0 {
            return Ok(AppliedRun {
                applied: 0,
                failure: logged.err().or(applied.failure),
            });
        }
        self.engine.events.wrote(&state.name);
        self.engine.events.check_watermark(state);
        let removes = entries[..applied.count]
            .iter()
            .any(|entry| entry.operation == EntryOperation::Delete);
        if removes {
            self.engine.memory.memory_released();
        }
        let durable =
            logged.and_then(|received| log.wait_durable(&received, applied.position.seq_no));
        Ok(match durable {
            Ok(()) => AppliedRun {
                applied: applied.count,
                failure: applied.failure,
            },
            Err(failure) => AppliedRun {
                applied: 0,
                failure: Some(failure),
            },
        })
    }
}
