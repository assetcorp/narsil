use std::sync::Arc;

use super::{apply_remove, replace_document};
use crate::engine::durable::log::PendingLog;
use crate::engine::index::IndexState;
use crate::error::Result;
use crate::index::segment::SegmentEntry;
use crate::value::Map;

/// Applies an `INDEX` record of the write-ahead log: the document replaces any copy that the index holds, without
/// the checks that the write passed before the log took it.
pub(crate) fn replay_index(index: &IndexState, id: &str, document: Map) -> Result<()> {
    let routed = index.route(id, index.partitions().len());
    place_document(index, routed, id, document)
}

/// Adds a stored document to the partition at `partition_at`, where an earlier release's checkpoint holds it,
/// replacing any copy that the index holds.
pub(crate) fn place_document(
    index: &IndexState,
    partition_at: usize,
    id: &str,
    mut document: Map,
) -> Result<()> {
    let partitions = index.partitions();
    if partition_at >= partitions.len() {
        return Err(index.not_found(id));
    }
    let held_at = index.locate(&partitions, id)?;
    let vectors = index.vectors.take_vectors(&mut document, false);
    let indexed = index.index_document(&document)?;
    index.changes.track_write(id)?;
    let undo = index.vectors.update_vectors(id, &vectors)?;
    let stored = Arc::new(document);
    let freeze = |entry: &SegmentEntry| index.freeze_entry(entry);
    let placed = index.publish(|| match held_at {
        Some(at) => replace_document(index, &partitions, at, partition_at, id, stored, indexed),
        None => partitions[partition_at]
            .write(|snapshot| snapshot.append(id.to_string(), stored, indexed, &freeze)),
    });
    if placed.is_err() {
        index.vectors.undo(id, undo);
    }
    placed
}

/// Applies a `DELETE` record of the write-ahead log, which removes nothing where the index holds no such document.
pub(crate) fn replay_delete(index: &IndexState, id: &str) -> Result<()> {
    let partitions = index.partitions();
    if index.locate(&partitions, id)?.is_some() {
        return apply_remove(index, &partitions, id, &mut PendingLog::begin(None)?);
    }
    let removed = index.vectors.remove_vectors(id);
    index.vectors.publish_writes();
    removed
}
