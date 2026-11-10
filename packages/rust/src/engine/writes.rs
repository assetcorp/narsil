mod batch;
mod replay;

use std::sync::Arc;

use super::durable::log::PendingLog;
use super::index::IndexState;
use crate::config::validate_doc_id;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::index::indexed::IndexedDocument;
use crate::index::partition::Partition;
use crate::index::segment::SegmentEntry;
use crate::schema::{
    require_document_within_size_limit, validate_document, validate_document_strict,
    validate_required_fields,
};
use crate::value::{Map, Value};

pub(crate) use batch::{insert_batch, remove_batch, update_batch};
pub(crate) use replay::{place_document, replay_delete, replay_index};

/// Gives the ID of a document inserted without one, as the engine's ID generator says.
pub(crate) type NextDocumentId<'a> = dyn Fn() -> Result<String> + 'a;

/// One document of a batch that the engine refused, with the reason.
#[derive(Debug, Clone, PartialEq)]
pub struct BatchFailure {
    /// The ID of the refused document, or an empty string where the document gave none.
    pub doc_id: String,
    /// Why the engine refused it.
    pub error: NarsilError,
}

/// What a batch write did: the IDs that it wrote, in order, and the documents that it refused.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BatchResult {
    /// The IDs of the documents that the batch wrote.
    pub succeeded: Vec<String>,
    /// The documents that the batch refused, each with its error.
    pub failed: Vec<BatchFailure>,
}

pub(crate) fn provided_doc_id(document: &Map) -> Option<&str> {
    match document.get("id") {
        Some(Value::String(id)) if !id.is_empty() => Some(id),
        _ => None,
    }
}

pub(crate) fn require_matching_doc_id(doc_id: &str, document: &Map) -> Result<()> {
    match provided_doc_id(document) {
        Some(embedded) if embedded != doc_id => Err(NarsilError::new(
            ErrorCode::DOC_VALIDATION_FAILED,
            format!(
                "The call names document id \"{doc_id}\" while the document's own id field is \"{embedded}\", so the stored document would contradict the key that it is stored under"
            ),
        )),
        _ => Ok(()),
    }
}

fn require_required_fields(index: &IndexState, document: &Map) -> Result<()> {
    match &index.config().required {
        Some(required) if !required.is_empty() => validate_required_fields(document, required),
        _ => Ok(()),
    }
}

fn assert_capacity(index: &IndexState, partitions: &[Arc<Partition>], pending: u64) -> Result<()> {
    let Some(per_partition) = index
        .config()
        .partitions
        .as_ref()
        .and_then(|partitions| partitions.max_docs_per_partition)
    else {
        return Ok(());
    };
    let count = index.changes.capacity_partitions(partitions.len()) as u64;
    let total_capacity = per_partition.saturating_mul(count);
    let current: u64 = partitions
        .iter()
        .map(|partition| partition.snapshot().document_count())
        .sum::<u64>()
        + pending;
    if current < total_capacity {
        return Ok(());
    }
    Err(NarsilError::new(
        ErrorCode::PARTITION_CAPACITY_EXCEEDED,
        format!(
            "Index \"{}\" has reached its capacity of {total_capacity} documents ({per_partition} per partition × {count} partitions)",
            index.name
        ),
    ))
}

fn validated(index: &IndexState, document: &Map) -> Result<()> {
    validate_document(document, &index.schema, index.pattern_value_limit())?;
    if index.config().strict == Some(true) {
        validate_document_strict(document, &index.schema)?;
    }
    Ok(())
}

fn already_exists(id: &str, partition: usize) -> NarsilError {
    NarsilError::new(
        ErrorCode::DOC_ALREADY_EXISTS,
        format!("Document \"{id}\" already exists in partition {partition}"),
    )
}

/// Adds a document that passed every check before the partition, while the caller holds the write lock.
///
/// The vectors go in before the document, and come out again where the partition refuses it, so that a search
/// sees the document whole or not at all.
fn apply_insert(
    index: &IndexState,
    partitions: &[Arc<Partition>],
    id: &str,
    mut document: Map,
    log: &mut PendingLog<'_>,
) -> Result<()> {
    let routed = index.route(id, partitions.len());
    let Some(partition) = partitions.get(routed) else {
        return Err(index.not_found(id));
    };
    if partition.snapshot().has(id)? {
        return Err(already_exists(id, routed));
    }
    index.vectors.require_dimensions(&document)?;
    validated(index, &document)?;
    let encoded = log.encode(&document)?;
    let vectors = index.vectors.take_vectors(&mut document, false);
    let indexed = index.index_document(&document)?;
    let stored = Arc::new(document);
    index.changes.track_write(id)?;
    index.vectors.insert_vectors(id, &vectors)?;
    let freeze = |entry: &SegmentEntry| index.freeze_entry(entry);
    let appended = index.publish(|| {
        partition.write(|snapshot| snapshot.append(id.to_string(), stored, indexed, &freeze))
    });
    match appended {
        Ok(()) => log.record_index(routed as u32, id, encoded),
        Err(_) => {
            let _ = index.vectors.remove_vectors(id);
        }
    }
    appended
}

fn held_document(held: &mut Option<Map>) -> Result<&mut Map> {
    held.as_mut().ok_or_else(|| {
        NarsilError::new(
            ErrorCode::DOC_VALIDATION_FAILED,
            "The write received no document",
        )
    })
}

/// Inserts one document and returns its ID, after the checks that every Narsil engine applies in the same order.
///
/// The document stays in `held` until the write holds the index's write lock, so that a caller can run the write
/// again where the lock refuses it.
pub(crate) fn insert(
    index: &IndexState,
    held: &mut Option<Map>,
    doc_id: Option<&str>,
    next_id: &NextDocumentId<'_>,
) -> Result<String> {
    let document = held_document(held)?;
    if let Some(doc_id) = doc_id {
        require_matching_doc_id(doc_id, document)?;
    }
    let id = match doc_id.or_else(|| provided_doc_id(document)) {
        Some(id) => id.to_string(),
        None => next_id()?,
    };
    validate_doc_id(&id)?;
    require_required_fields(index, document)?;
    index.vectors.embed_for_write(document)?;
    require_document_within_size_limit(document)?;
    let appended = {
        let _writer = index.lock_writes()?;
        let document = held.take().ok_or_else(|| index.not_found(&id))?;
        let mut log = PendingLog::begin(index.log())?;
        let partitions = index.partitions();
        assert_capacity(index, &partitions, 0)?;
        apply_insert(index, &partitions, &id, document, &mut log)?;
        log.append()
    };
    appended.wait_for_one()?;
    Ok(id)
}

/// Replaces a stored document, putting its old vectors back where the partition refuses the new document.
fn apply_update(
    index: &IndexState,
    partitions: &[Arc<Partition>],
    id: &str,
    mut document: Map,
    log: &mut PendingLog<'_>,
) -> Result<()> {
    index.vectors.require_dimensions(&document)?;
    let Some(at) = index.locate(partitions, id)? else {
        return Err(index.not_found(id));
    };
    validated(index, &document)?;
    let encoded = log.encode(&document)?;
    let vectors = index.vectors.take_vectors(&mut document, true);
    let indexed = index.index_document(&document)?;
    index.changes.track_write(id)?;
    let undo = index.vectors.update_vectors(id, &vectors)?;
    let routed = index.route(id, partitions.len());
    let replaced = index.publish(|| {
        replace_document(
            index,
            partitions,
            at,
            routed,
            id,
            Arc::new(document),
            indexed,
        )
    });
    match replaced {
        Ok(()) => log.record_index(index.route(id, partitions.len()) as u32, id, encoded),
        Err(_) => index.vectors.undo(id, undo),
    }
    replaced
}

fn replace_document(
    index: &IndexState,
    partitions: &[Arc<Partition>],
    at: usize,
    target: usize,
    id: &str,
    stored: Arc<Map>,
    indexed: IndexedDocument,
) -> Result<()> {
    let analyse = |document: &Map| index.index_document(document);
    let freeze = |entry: &SegmentEntry| index.freeze_entry(entry);
    if target != at {
        partitions[at].write(|snapshot| snapshot.remove(id, &analyse))?;
        let target = partitions.get(target).unwrap_or(&partitions[at]);
        return target.write(|snapshot| snapshot.append(id.to_string(), stored, indexed, &freeze));
    }
    partitions[at].write(|snapshot| {
        snapshot.remove(id, &analyse)?;
        snapshot.append(id.to_string(), stored, indexed, &freeze)
    })
}

/// Runs the checks of an update that come before the write lock, embedding the text of the document on the way.
fn prepare_update(index: &IndexState, doc_id: &str, document: &mut Map) -> Result<()> {
    validate_doc_id(doc_id)?;
    require_matching_doc_id(doc_id, document)?;
    require_required_fields(index, document)?;
    index.vectors.embed_for_write(document)?;
    require_document_within_size_limit(document)
}

/// Replaces the document stored under `doc_id` with the document in `held`, which stays there until the write
/// holds the index's write lock.
pub(crate) fn update(index: &IndexState, doc_id: &str, held: &mut Option<Map>) -> Result<()> {
    prepare_update(index, doc_id, held_document(held)?)?;
    let appended = {
        let _writer = index.lock_writes()?;
        let document = held.take().ok_or_else(|| index.not_found(doc_id))?;
        let mut log = PendingLog::begin(index.log())?;
        let partitions = index.partitions();
        apply_update(index, &partitions, doc_id, document, &mut log)?;
        log.append()
    };
    appended.wait_for_one()
}

pub(crate) fn apply_remove(
    index: &IndexState,
    partitions: &[Arc<Partition>],
    id: &str,
    log: &mut PendingLog<'_>,
) -> Result<()> {
    let Some(at) = index.locate(partitions, id)? else {
        return Err(index.not_found(id));
    };
    let analyse = |document: &Map| index.index_document(document);
    index.changes.track_write(id)?;
    let undo = index.vectors.remove_document_vectors(id)?;
    let removed =
        index.publish(
            || match partitions[at].write(|snapshot| snapshot.remove(id, &analyse))? {
                Some(_) => Ok(()),
                None => Err(index.not_found(id)),
            },
        );
    match removed {
        Ok(()) => log.record_delete(index.route(id, partitions.len()) as u32, id),
        Err(_) => index.vectors.undo(id, undo),
    }
    removed
}

/// Removes the document stored under `doc_id`.
pub(crate) fn remove(index: &IndexState, doc_id: &str) -> Result<()> {
    validate_doc_id(doc_id)?;
    let appended = {
        let _writer = index.lock_writes()?;
        let mut log = PendingLog::begin(index.log())?;
        let partitions = index.partitions();
        apply_remove(index, &partitions, doc_id, &mut log)?;
        log.append()
    };
    appended.wait_for_one()
}
