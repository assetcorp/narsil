use super::Narsil;
use super::changes::ChangeKind;
use super::durable::checkpoint_now;
use super::durable::log::PendingLog;
use super::index::IndexState;
use super::sync::renew_epoch_locked;
use crate::error::Result;
use crate::index::partition::Partition;

fn layout_change_runs(index: &IndexState) -> bool {
    index.changes.runs(ChangeKind::Rebalance) || index.changes.runs(ChangeKind::Analysis)
}

/// Records every live document of the index as written, so that a rebalance or an analysis change that runs now
/// drops each one from its new partitions before they replace the cleared ones.
fn track_every_document(
    index: &IndexState,
    partitions: &[std::sync::Arc<Partition>],
) -> Result<()> {
    for partition in partitions {
        let snapshot = partition.snapshot();
        for entry in &snapshot.segments {
            for ordinal in (0..entry.capacity()).filter(|&ordinal| !entry.is_removed(ordinal)) {
                index.changes.track_write(&entry.id_of(ordinal)?)?;
            }
        }
    }
    Ok(())
}

fn clear_vectors(index: &IndexState) -> Result<()> {
    for entry in index.vectors.fields() {
        entry.field.shared.cancel_cold_hold(true);
        let generation = entry.field.shared.current();
        let ids: Vec<String> = generation
            .live_ordinals()
            .into_iter()
            .filter_map(|ordinal| generation.doc_id(ordinal).map(str::to_string))
            .collect();
        drop(generation);
        for id in &ids {
            entry.field.remove(id)?;
        }
        entry.field.compact()?;
    }
    Ok(())
}

fn clear_index(index: &IndexState) -> Result<()> {
    {
        let _writer = index.lock_writes()?;
        drop(PendingLog::begin(index.log())?);
        renew_epoch_locked(index)?;
        let partitions = index.partitions();
        if layout_change_runs(index) {
            track_every_document(index, &partitions)?;
        }
        for partition in partitions.iter() {
            partition.write(|snapshot| snapshot.clear());
        }
        clear_vectors(index)?;
    }
    checkpoint_now(index)
}

impl Narsil {
    /// Removes every document of an index and keeps its schema, settings, and partitions, so that the index takes
    /// new documents at once.
    ///
    /// A durable engine writes a checkpoint of the empty index before it returns, so that a restart under either
    /// durability tier finds the index empty. Fails with `INDEX_NOT_FOUND` where the engine holds no index called
    /// `index`, with `PARTITION_REBALANCING_BACKPRESSURE` where a running rebalance cannot queue every document
    /// that the clear removes, and with the error of the index's log where an earlier write left that log unusable;
    /// the index keeps its documents in each of those cases.
    pub fn clear(&self, index: &str) -> Result<()> {
        let writable = self.inner.writable_index(index)?;
        let state = std::sync::Arc::clone(writable.index());
        let outcome = clear_index(&state);
        drop(writable);
        self.inner.events.wrote(&state.name);
        self.inner.events.check_watermark(&state);
        outcome
    }
}
