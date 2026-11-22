use std::sync::Arc;

use narsil::Value;
use narsil::replication::{CopyPosition, HeldTerm, ReplicatedEntry};

use super::PrimaryWrites;
use super::partition::Partition;
use crate::controller::lock;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::payload::entry::WireEntry;
use crate::payload::replica::{EntryRun, holds_checksum};

fn refused(code: &str, wire: &WireEntry, message: String) -> ClusterError {
    ClusterError::new(code, message)
        .with_detail("indexName", Value::from(wire.index_name.as_str()))
        .with_detail("partitionId", Value::from(wire.partition_id))
        .with_detail("seqNo", Value::from(wire.entry.seq_no))
}

fn corrupt(wire: &WireEntry) -> ClusterError {
    refused(
        codes::REPLICATION_ENTRY_CORRUPT,
        wire,
        format!("Invalid replication entry {}", wire.entry.seq_no),
    )
}

enum Held {
    Same,
    Other,
    Uncovered,
}

fn held_as(term: HeldTerm, primary_term: u64) -> Held {
    match term {
        HeldTerm::Held(held) if held == primary_term => Held::Same,
        HeldTerm::Held(_) | HeldTerm::Absent => Held::Other,
        HeldTerm::Uncovered => Held::Uncovered,
    }
}

struct Ordered<'p> {
    partition: &'p Partition,
    index_name: String,
    partition_id: u32,
    tail: CopyPosition,
    run: Vec<ReplicatedEntry>,
    skipped_entries: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum EntrySource {
    Primary,
    Sync,
}

impl Ordered<'_> {
    fn known_term(&self, seq_no: u64) -> Option<u64> {
        if let Some(term) = lock(&self.partition.log).term_at(seq_no) {
            return Some(term);
        }
        (seq_no == self.tail.seq_no).then_some(self.tail.primary_term)
    }

    fn take(&mut self, wire: WireEntry) {
        self.tail = CopyPosition {
            seq_no: wire.entry.seq_no,
            primary_term: wire.entry.primary_term,
        };
        self.run.push(wire.entry);
    }
}

impl PrimaryWrites {
    pub(super) async fn apply_in_log_order(
        self: &Arc<Self>,
        partition: &Partition,
        run: EntryRun,
        source: EntrySource,
    ) -> ClusterResult<()> {
        let Some(first) = run.entries.first() else {
            return Ok(());
        };
        let (index_name, partition_id) = (first.index_name.clone(), first.partition_id);
        if self.failures.is_failed(&index_name, partition_id) {
            return Err(self.failed_copy_refusal(&index_name, partition_id));
        }
        let name = index_name.clone();
        let (tail, failure) = self
            .on_copies(move |copies| {
                let position = copies.position(&name, partition_id)?;
                Ok((position, copies.copy_failure(&name, partition_id)?))
            })
            .await?;
        if let Some(failure) = failure {
            self.record_copy_failure(&index_name, partition_id);
            return Err(ClusterError::from(failure));
        }
        let mut ordered = Ordered {
            partition,
            index_name,
            partition_id,
            tail,
            run: Vec::new(),
            skipped_entries: false,
        };
        let mut expected_previous = run.previous_primary_term;
        for wire in run.entries {
            let expected_before = expected_previous.replace(wire.entry.primary_term);
            if let Err(error) = self.order(&mut ordered, wire, expected_before).await {
                self.apply_held_run(&mut ordered).await?;
                if source == EntrySource::Primary && ordered.skipped_entries {
                    self.record_copy_failure(&ordered.index_name, partition_id);
                }
                return Err(error);
            }
        }
        self.apply_held_run(&mut ordered).await
    }

    async fn order(
        &self,
        ordered: &mut Ordered<'_>,
        wire: WireEntry,
        expected_before: Option<u64>,
    ) -> ClusterResult<()> {
        let seq_no = wire.entry.seq_no;
        let existing = lock(&ordered.partition.log)
            .entry_at(seq_no)
            .map(|held| held.checksum(&ordered.index_name, ordered.partition_id));
        if let Some(checksum) = existing {
            if checksum != wire.checksum {
                return Err(refused(
                    codes::REPLICATION_ENTRY_INVALID,
                    &wire,
                    format!("Conflicting replication entry at sequence number {seq_no}"),
                ));
            }
            return Ok(());
        }
        let tail = ordered.tail;
        if seq_no <= tail.seq_no && ordered.known_term(seq_no) == Some(wire.entry.primary_term) {
            return if holds_checksum(&wire) {
                Ok(())
            } else {
                Err(corrupt(&wire))
            };
        }
        let oldest = lock(&ordered.partition.log).oldest_seq_no();
        if seq_no <= tail.seq_no && oldest.is_none_or(|oldest| seq_no < oldest) {
            return self.acknowledge_evicted(ordered, &wire).await;
        }
        if seq_no == tail.seq_no + 1
            && let Some(expected) = expected_before
            && tail.primary_term != expected
        {
            return Err(refused(
                codes::REPLICATION_ENTRY_INVALID,
                &wire,
                format!(
                    "Replication entry {seq_no} follows an entry of term {expected}, but this copy holds sequence number {} under term {}",
                    tail.seq_no, tail.primary_term
                ),
            )
            .with_detail("previousPrimaryTerm", Value::from(expected))
            .with_detail("heldPrimaryTerm", Value::from(tail.primary_term)));
        }
        let expected_seq_no = tail.seq_no + 1;
        if seq_no != expected_seq_no {
            ordered.skipped_entries = seq_no > expected_seq_no
                && holds_checksum(&wire)
                && wire.entry.primary_term >= tail.primary_term;
            return Err(refused(
                codes::REPLICATION_ENTRY_INVALID,
                &wire,
                format!("Out-of-order replication entry {seq_no}; expected {expected_seq_no}"),
            )
            .with_detail("expectedSeqNo", Value::from(expected_seq_no)));
        }
        if !holds_checksum(&wire) {
            return Err(corrupt(&wire));
        }
        if wire.entry.primary_term < tail.primary_term {
            return Err(refused(
                codes::REPLICATION_TERM_MISMATCH,
                &wire,
                format!("Invalid replication entry {seq_no}"),
            ));
        }
        ordered.take(wire);
        Ok(())
    }

    async fn acknowledge_evicted(
        &self,
        ordered: &Ordered<'_>,
        wire: &WireEntry,
    ) -> ClusterResult<()> {
        let (name, partition_id, seq_no) = (
            ordered.index_name.clone(),
            ordered.partition_id,
            wire.entry.seq_no,
        );
        let term = self
            .on_copies(move |copies| copies.held_term(&name, partition_id, seq_no))
            .await?;
        match held_as(term, wire.entry.primary_term) {
            Held::Same if holds_checksum(wire) => Ok(()),
            Held::Same => Err(corrupt(wire)),
            Held::Other => Err(refused(
                codes::REPLICATION_ENTRY_INVALID,
                wire,
                format!(
                    "This copy holds sequence number {seq_no} under another term than replication entry {seq_no}"
                ),
            )),
            Held::Uncovered => Err(refused(
                codes::REPLICATION_ENTRY_INVALID,
                wire,
                format!(
                    "Replication entry {seq_no} lies below the oldest entry that this copy retains, and its term history no longer covers that sequence number"
                ),
            )),
        }
    }

    async fn apply_held_run(self: &Arc<Self>, ordered: &mut Ordered<'_>) -> ClusterResult<()> {
        let run = std::mem::take(&mut ordered.run);
        if run.is_empty() {
            return Ok(());
        }
        let (name, partition_id) = (ordered.index_name.clone(), ordered.partition_id);
        let entries = run.clone();
        let (applied, copy_failure) = self
            .on_copies(move |copies| copies.replica_append(&name, partition_id, &entries))
            .await?;
        let taken = &run[..applied.applied.min(run.len())];
        lock(&ordered.partition.log).append(&ordered.index_name, taken);
        if copy_failure.is_some() {
            self.record_copy_failure(&ordered.index_name, partition_id);
        }
        if taken.len() == run.len() {
            return Ok(());
        }
        Err(applied.failure.map_or_else(
            || {
                ClusterError::new(
                    codes::REPLICATION_ENTRY_INVALID,
                    format!(
                        "Partition {partition_id} of index '{}' applied {} of {} replication entries",
                        ordered.index_name,
                        taken.len(),
                        run.len()
                    ),
                )
            },
            ClusterError::from,
        ))
    }
}
