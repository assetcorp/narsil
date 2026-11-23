use std::sync::Arc;

use super::copy_state::PartitionCopy;
use super::logged::CopyLog;
use super::{CopyPosition, PartitionCopies};
use crate::engine::constants::MAX_PARTITION_RELOAD_READS;
use crate::engine::durable::checkpoint_locked;
use crate::engine::durable::reload::{
    checkpoint_kept_moving, checkpoint_moved, read_checkpointed, stored_partition,
};
use crate::engine::index::IndexState;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::index::partition::PartitionSnapshot;
use crate::index::segment::SegmentEntry;
use crate::value::{MAX_SAFE_INTEGER, Map, Value};

pub(super) fn replace_documents(
    index: &IndexState,
    partition: u32,
    documents: Vec<(String, Map)>,
) -> Result<()> {
    let partitions = index.partitions();
    let Some(target) = partitions.get(partition as usize) else {
        return Err(super::copy_state::no_such_partition(&index.name, partition));
    };
    let mut removed = Vec::new();
    let mut replacement = PartitionSnapshot::new(index.track_positions);
    {
        let held = target.snapshot();
        replacement.next_segment_id = held.next_segment_id;
        for entry in &held.segments {
            for ordinal in entry.live_ordinals() {
                removed.push(entry.id_of(ordinal)?.into_owned());
            }
        }
    }
    let freeze = |entry: &SegmentEntry| index.freeze_entry(entry);
    let mut vectors = Vec::with_capacity(documents.len());
    for (id, mut document) in documents {
        let taken = index.vectors.take_vectors(&mut document, false);
        let indexed = index.index_document(&document)?;
        replacement.append(id.clone(), Arc::new(document), indexed, &freeze)?;
        vectors.push((id, taken));
    }
    index.publish(|| {
        for id in &removed {
            index.changes.track_write(id)?;
            index.vectors.remove_vectors(id)?;
        }
        for (id, taken) in &vectors {
            index.changes.track_write(id)?;
            index.vectors.update_vectors(id, taken)?;
        }
        target.write(|held| *held = replacement);
        Ok(())
    })
}

impl PartitionCopies<'_> {
    /// Deletes the partition's documents, its write-ahead log, its records, and its history, and saves the empty
    /// copy, as a failed replica must before it syncs again from zero. Every other partition keeps serving.
    pub fn empty_partition(&self, index: &str, partition: u32) -> Result<()> {
        let writable = self.engine.writable_index(index)?;
        let state = writable.index();
        {
            let _writer = state.lock_writes()?;
            let copy = super::copy_of(state)?;
            drop(copy.partition(&state.name, partition)?);
            let log = CopyLog::of(state, partition);
            log.discard()
                .and_then(|()| replace_documents(state, partition, Vec::new()))
                .and_then(|()| {
                    *copy.partition(&state.name, partition)? = PartitionCopy::default();
                    checkpoint_locked(state)
                })
                .inspect_err(|failure| log.fail(failure))?;
        }
        self.engine.memory.memory_released();
        self.engine.events.wrote(&state.name);
        Ok(())
    }

    /// Reads the partition again from its checkpoint and its write-ahead log in place of what memory holds, as
    /// the last copy of a partition must after it fails. A failure leaves the partition failed.
    ///
    /// The copy reads only this partition's segments and vectors from the checkpoint, and it reads them before it
    /// takes the index's write lock, so that writes to the other partitions go on meanwhile. It holds the lock only
    /// to replay the partition's log and put the partition in place. Where a checkpoint that committed meanwhile
    /// moved the partition's position, it lets the lock go and reads the newer checkpoint, and it fails with
    /// `PERSISTENCE_LOAD_FAILED` once checkpoints have moved the position during a bounded number of reads. Before
    /// it decodes each vector file, and before it puts the partition's vectors into its documents, it checks that
    /// the process has the memory free, and it fails with `PERSISTENCE_LOAD_FAILED` where the work would pass the
    /// process's limit.
    pub fn reload_partition(&self, index: &str, partition: u32) -> Result<()> {
        let writable = self.engine.writable_index(index)?;
        let state = writable.index();
        let mut reads = 0;
        loop {
            reads += 1;
            let read = read_checkpointed(self.engine, state, partition);
            let _writer = state.lock_writes()?;
            let copy = super::copy_of(state)?;
            drop(copy.partition(&state.name, partition)?);
            let log = CopyLog::of(state, partition);
            let unmoved = read
                .and_then(|read| match checkpoint_moved(state, partition, &read)? {
                    false => Ok(Some(read)),
                    true if reads < MAX_PARTITION_RELOAD_READS => Ok(None),
                    true => Err(checkpoint_kept_moving(state, partition, reads)),
                })
                .inspect_err(|failure| log.fail(failure))?;
            let Some(read) = unmoved else {
                continue;
            };
            stored_partition(read, state, partition)
                .and_then(|stored| {
                    let position = stored.copy.position;
                    replace_documents(state, partition, stored.documents)?;
                    *copy.partition(&state.name, partition)? = stored.copy;
                    log.resume(stored.replayed.as_ref(), position)
                })
                .and_then(|()| checkpoint_locked(state))
                .inspect_err(|failure| log.fail(failure))?;
            break;
        }
        self.engine.events.wrote(&state.name);
        Ok(())
    }

    /// Numbers the copy's next entry after `position`, as a primary does that the cluster promotes with a stored
    /// commit point above the entries that its log recovered. A position at or below the copy's changes nothing.
    pub fn advance(&self, index: &str, partition: u32, position: CopyPosition) -> Result<()> {
        if position.seq_no > MAX_SAFE_INTEGER || position.primary_term > MAX_SAFE_INTEGER {
            return Err(NarsilError::new(
                ErrorCode::CONFIG_INVALID,
                format!(
                    "Partition {partition} of index \"{index}\" cannot number entries that high"
                ),
            )
            .with_details([("indexName", Value::from(index))]));
        }
        let writable = self.engine.writable_index(index)?;
        let state = writable.index();
        let _writer = state.lock_writes()?;
        let copy = super::copy_of(state)?;
        let log = CopyLog::of(state, partition);
        let reached = {
            let mut held = copy.partition(&state.name, partition)?;
            if let Some(failure) = &held.failure {
                return Err(failure.clone());
            }
            if position.seq_no <= held.position.seq_no {
                return Ok(());
            }
            let reached = CopyPosition {
                seq_no: position.seq_no,
                primary_term: position.primary_term.max(held.position.primary_term).max(1),
            };
            held.reach(reached);
            reached
        };
        log.restart_after(reached)
            .and_then(|()| checkpoint_locked(state))
            .inspect_err(|failure| log.fail(failure))
    }
}
