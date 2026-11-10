use std::sync::Arc;

use super::apply_remove;
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
    let mut unlogged = PendingLog::begin(None)?;
    if index.locate(&partitions, id)?.is_some() {
        apply_remove(index, &partitions, id, &mut unlogged)?;
    }
    let Some(partition) = partitions.get(partition_at) else {
        return Err(index.not_found(id));
    };
    let vectors = index.vectors.take_vectors(&mut document, false);
    let indexed = index.index_document(&document)?;
    index.vectors.insert_vectors(id, &vectors)?;
    let freeze = |entry: &SegmentEntry| index.freeze_entry(entry);
    let appended = partition
        .write(|snapshot| snapshot.append(id.to_string(), Arc::new(document), indexed, &freeze));
    if appended.is_err() {
        let _ = index.vectors.remove_vectors(id);
    }
    index.vectors.publish_writes();
    appended
}

/// Applies a `DELETE` record of the write-ahead log, which removes nothing where the index holds no such document.
pub(crate) fn replay_delete(index: &IndexState, id: &str) -> Result<()> {
    let partitions = index.partitions();
    let removed = if index.locate(&partitions, id)?.is_none() {
        index.vectors.remove_vectors(id)
    } else {
        apply_remove(index, &partitions, id, &mut PendingLog::begin(None)?)
    };
    index.vectors.publish_writes();
    removed
}
