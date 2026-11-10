use std::sync::Arc;

use super::ChangeTicket;
use super::replaced;
use crate::analysis::Analyser;
use crate::engine::EngineInner;
use crate::engine::constants::REBUILD_CHUNK_DOCUMENTS;
use crate::engine::index::IndexState;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::index::indexed::{IndexedDocument, IndexingOptions, index_document};
use crate::index::partition::{Partition, PartitionSnapshot};
use crate::value::Map;

/// One rebuild of an index's partitions: the analysis that writes the new terms and the number of partitions
/// that the documents spread over.
pub(crate) struct Rebuild<'a> {
    pub(crate) engine: &'a EngineInner,
    pub(crate) index: &'a IndexState,
    pub(crate) ticket: &'a ChangeTicket<'a>,
    pub(crate) analyser: &'a Analyser,
    pub(crate) partition_count: usize,
}

/// Returns the lowest segment ID that no partition of `snapshots` has used, which every new partition starts
/// from so that no file of a new segment lands on a key that the newest checkpoint lists.
pub(crate) fn first_free_segment_id(snapshots: &[Arc<PartitionSnapshot>]) -> u64 {
    snapshots
        .iter()
        .map(|snapshot| snapshot.next_segment_id)
        .max()
        .unwrap_or(0)
}

impl Rebuild<'_> {
    /// Fails where the engine shut down, the index left the engine, or a later change asked this one to stop.
    pub(crate) fn require_current(&self) -> Result<()> {
        self.engine.guard_shutdown()?;
        if self.index.is_retired() {
            return Err(NarsilError::new(
                ErrorCode::INDEX_NOT_FOUND,
                format!(
                    "Index \"{}\" was dropped or replaced while its partitions were rebuilt",
                    self.index.name
                ),
            ));
        }
        if self.ticket.stopped() {
            return Err(replaced(&self.index.name));
        }
        Ok(())
    }

    fn indexed(&self, document: &Map) -> Result<IndexedDocument> {
        index_document(
            document,
            &self.index.schema,
            &IndexingOptions {
                analyser: self.analyser,
                track_positions: self.index.track_positions,
                collect_surfaces: self.index.collect_surfaces,
            },
        )
    }

    /// Builds the new partitions from the documents of `source`, a view of the old partitions taken at one moment,
    /// and reports each finished source partition to `progress`.
    pub(crate) fn build(
        &self,
        source: &[Arc<PartitionSnapshot>],
        progress: &mut dyn FnMut(usize),
    ) -> Result<Vec<Arc<Partition>>> {
        let first_segment_id = first_free_segment_id(source);
        let mut built: Vec<PartitionSnapshot> = (0..self.partition_count.max(1))
            .map(|_| {
                let mut snapshot = PartitionSnapshot::new(self.index.track_positions);
                snapshot.next_segment_id = first_segment_id;
                snapshot
            })
            .collect();
        let mut since_check = 0usize;
        for (done, snapshot) in source.iter().enumerate() {
            for entry in &snapshot.segments {
                for ordinal in entry.live_ordinals() {
                    let id = entry.id_of(ordinal)?.into_owned();
                    let routed = self.index.route(&id, built.len());
                    let Some(target) = built.get_mut(routed) else {
                        continue;
                    };
                    if target.has(&id)? {
                        continue;
                    }
                    let document = entry.document(ordinal)?;
                    let indexed = self.indexed(&document)?;
                    target.append(id, document, indexed)?;
                    since_check += 1;
                    if since_check >= REBUILD_CHUNK_DOCUMENTS {
                        since_check = 0;
                        self.require_current()?;
                    }
                }
            }
            progress(done + 1);
        }
        self.require_current()?;
        Ok(built
            .into_iter()
            .map(|snapshot| Arc::new(Partition::new(snapshot)))
            .collect())
    }

    /// Brings each document of `ids` in `built` to the state that the old partitions `current` hold for it now,
    /// removing the copy that `built` holds and adding the one that `current` holds, if any.
    pub(crate) fn apply_written(
        &self,
        built: &[Arc<Partition>],
        current: &[Arc<Partition>],
        ids: &[String],
    ) -> Result<()> {
        let analyse = |document: &Map| self.indexed(document).ok();
        for id in ids {
            if let Some(at) = self.index.locate(built, id)?
                && let Some(partition) = built.get(at)
            {
                partition.write(|snapshot| snapshot.remove(id, &analyse))?;
            }
            let Some(at) = self.index.locate(current, id)? else {
                continue;
            };
            let Some(document) = current
                .get(at)
                .map(|partition| partition.snapshot().document(id))
                .transpose()?
                .flatten()
            else {
                continue;
            };
            let indexed = self.indexed(&document)?;
            let routed = self.index.route(id, built.len());
            if let Some(target) = built.get(routed) {
                target.write(|snapshot| snapshot.append(id.clone(), document, indexed))?;
            }
        }
        Ok(())
    }
}

/// Returns the number of live documents that `partitions` hold.
pub(crate) fn document_total(partitions: &[Arc<Partition>]) -> u64 {
    partitions
        .iter()
        .map(|partition| partition.snapshot().document_count())
        .sum()
}
