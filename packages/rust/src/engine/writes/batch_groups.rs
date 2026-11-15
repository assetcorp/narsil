use std::sync::Arc;

use super::{
    BatchFailure, BatchResult, NextDocumentId, apply_insert, apply_update, assert_capacity,
    provided_doc_id, require_matching_doc_id,
};
use crate::config::validate_doc_id;
use crate::engine::durable::log::PendingLog;
use crate::engine::index::IndexState;
use crate::engine::memory::{MemoryGuard, WriteProjection, refused_after};
use crate::engine::vectors::HeldWrite;
use crate::error::NarsilError;
use crate::index::partition::Partition;
use crate::schema::require_document_within_size_limit;
use crate::value::Map;

pub(super) struct InsertItem {
    pub(super) document: Map,
    pub(super) resolved: Option<String>,
}

fn known_id(item: &InsertItem) -> String {
    item.resolved
        .as_deref()
        .or_else(|| provided_doc_id(&item.document))
        .unwrap_or_default()
        .to_string()
}

fn insert_one(
    index: &IndexState,
    partitions: &[Arc<Partition>],
    log: &mut PendingLog<'_>,
    item: InsertItem,
    result: &mut BatchResult,
    next_id: &NextDocumentId<'_>,
) {
    let InsertItem { document, resolved } = item;
    let id = match resolved.or_else(|| provided_doc_id(&document).map(str::to_string)) {
        Some(id) => id,
        None => match next_id() {
            Ok(id) => id,
            Err(error) => {
                result.failed.push(BatchFailure {
                    doc_id: String::new(),
                    error,
                });
                return;
            }
        },
    };
    let outcome = require_document_within_size_limit(&document)
        .and_then(|()| require_matching_doc_id(&id, &document))
        .and_then(|()| validate_doc_id(&id))
        .and_then(|()| index.vectors.require_dimensions(&document))
        .and_then(|()| assert_capacity(index, partitions, 0))
        .and_then(|()| apply_insert(index, partitions, &id, document, log));
    match outcome {
        Ok(()) => result.succeeded.push(id),
        Err(error) => result.failed.push(BatchFailure { doc_id: id, error }),
    }
}

fn refuse_from(
    index: &IndexState,
    ids: impl Iterator<Item = String>,
    error: NarsilError,
    result: &mut BatchResult,
) -> String {
    let mut ids = ids;
    let refused_doc_id = ids.next().unwrap_or_default();
    result.failed.push(BatchFailure {
        doc_id: refused_doc_id.clone(),
        error,
    });
    for doc_id in ids {
        let error = refused_after(&index.name, &doc_id, &refused_doc_id);
        result.failed.push(BatchFailure { doc_id, error });
    }
    refused_doc_id
}

pub(super) fn insert_in_groups(
    index: &IndexState,
    memory: &MemoryGuard,
    items: Vec<InsertItem>,
    log: &mut PendingLog<'_>,
    result: &mut BatchResult,
    next_id: &NextDocumentId<'_>,
) -> Option<String> {
    let partitions = index.partitions();
    let mut projection =
        WriteProjection::new(memory, index, items.iter().map(|item| &item.document));
    let mut slots: Vec<Option<InsertItem>> = items.into_iter().map(Some).collect();
    let mut start = 0;
    while start < slots.len() {
        let taken = projection.take_group(start, slots.len(), |at| {
            slots
                .get(at)
                .and_then(Option::as_ref)
                .map(|item| &item.document)
        });
        let group = match taken {
            Ok(group) if group.count > 0 => group,
            Ok(_) => return None,
            Err(error) => {
                let ids = slots[start..].iter().flatten().map(known_id);
                return Some(refuse_from(index, ids, error, result));
            }
        };
        for slot in &mut slots[start..start + group.count] {
            if let Some(item) = slot.take() {
                insert_one(index, &partitions, log, item, result, next_id);
            }
        }
        start += group.count;
    }
    None
}

fn prepared_at<'u>(
    updates: &'u [(String, HeldWrite)],
    positions: &[usize],
    at: usize,
) -> Option<&'u Map> {
    let position = *positions.get(at)?;
    updates.get(position).and_then(|(_, held)| held.prepared())
}

pub(super) fn update_in_groups(
    index: &IndexState,
    memory: &MemoryGuard,
    updates: &mut [(String, HeldWrite)],
    prepared: &[bool],
    log: &mut PendingLog<'_>,
    result: &mut BatchResult,
) -> Option<String> {
    let partitions = index.partitions();
    let empty = Map::new();
    let positions: Vec<usize> = prepared
        .iter()
        .enumerate()
        .filter_map(|(at, prepared)| prepared.then_some(at))
        .collect();
    let mut projection = WriteProjection::new(
        memory,
        index,
        (0..positions.len()).map(|at| prepared_at(updates, &positions, at).unwrap_or(&empty)),
    );
    let mut start = 0;
    while start < positions.len() {
        let shared: &[(String, HeldWrite)] = updates;
        let taken = projection.take_group(start, positions.len(), |at| {
            prepared_at(shared, &positions, at)
        });
        let group = match taken {
            Ok(group) if group.count > 0 => group,
            Ok(_) => return None,
            Err(error) => {
                let ids = positions[start..].iter().filter_map(|&position| {
                    updates.get(position).map(|(doc_id, _)| doc_id.clone())
                });
                return Some(refuse_from(index, ids, error, result));
            }
        };
        for &position in &positions[start..start + group.count] {
            let Some((doc_id, held)) = updates.get_mut(position) else {
                continue;
            };
            let Some(document) = held.take() else {
                continue;
            };
            match apply_update(index, &partitions, doc_id, document, log) {
                Ok(()) => result.succeeded.push(doc_id.clone()),
                Err(error) => result.failed.push(BatchFailure {
                    doc_id: doc_id.clone(),
                    error,
                }),
            }
        }
        start += group.count;
    }
    None
}
