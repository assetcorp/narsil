use super::{
    BatchFailure, BatchResult, NextDocumentId, apply_insert, apply_remove, apply_update,
    assert_capacity, prepare_update, provided_doc_id, require_matching_doc_id,
    require_required_fields,
};
use crate::config::validate_doc_id;
use crate::engine::constants::BATCH_CHUNK_DOCUMENTS;
use crate::engine::durable::log::{LogFailure, PendingLog};
use crate::engine::index::IndexState;
use crate::error::{NarsilError, Result};
use crate::index::partition::in_keyword_batch;
use crate::schema::require_document_within_size_limit;
use crate::value::Map;

/// Moves each document whose log record failed from the batch's successes to its failures.
fn settle_logged(result: &mut BatchResult, failures: Vec<LogFailure>) {
    for failure in failures {
        for doc_id in &failure.doc_ids {
            if let Some(at) = result.succeeded.iter().position(|held| held == doc_id) {
                result.succeeded.remove(at);
            }
        }
        refuse_each(result, failure.doc_ids, &failure.error);
    }
}

fn refuse_each(
    result: &mut BatchResult,
    doc_ids: impl IntoIterator<Item = String>,
    error: &NarsilError,
) {
    for doc_id in doc_ids {
        let error = error.clone();
        result.failed.push(BatchFailure { doc_id, error });
    }
}

fn refused_without_id(document: &Map, resolved: Option<&str>, error: NarsilError) -> BatchFailure {
    let doc_id = resolved
        .or_else(|| provided_doc_id(document))
        .unwrap_or_default()
        .to_string();
    BatchFailure { doc_id, error }
}

/// Inserts many documents, refusing each bad one alone, and returns what it wrote and what it refused.
///
/// `resolved_ids` gives, by position, the ID that a plugin hook already saw for a document, and the engine resolves
/// the ID of every document past its end, or with `None` there, from the document under the write lock.
/// The engine checks the required fields and embeds the text of each chunk of documents before it takes the write
/// lock for that chunk, so that an embedding call holds up no other write.
pub(crate) fn insert_batch(
    index: &IndexState,
    documents: Vec<Map>,
    resolved_ids: Vec<Option<String>>,
    next_id: &NextDocumentId<'_>,
) -> Result<BatchResult> {
    let mut result = BatchResult::default();
    let mut pending = documents.into_iter();
    let mut pending_ids = resolved_ids.into_iter();
    loop {
        let mut chunk: Vec<Map> = pending.by_ref().take(BATCH_CHUNK_DOCUMENTS).collect();
        if chunk.is_empty() {
            return Ok(result);
        }
        let ids: Vec<Option<String>> = chunk.iter().map(|_| pending_ids.next().flatten()).collect();
        let mut refused = vec![false; chunk.len()];
        for ((document, refused), id) in chunk.iter().zip(refused.iter_mut()).zip(&ids) {
            if let Err(error) = require_required_fields(index, document) {
                *refused = true;
                result
                    .failed
                    .push(refused_without_id(document, id.as_deref(), error));
            }
        }
        for (at, error) in index.vectors.embed_chunk(&mut chunk, &mut refused) {
            if let Some(document) = chunk.get(at) {
                let id = ids.get(at).and_then(Option::as_deref);
                result.failed.push(refused_without_id(document, id, error));
            }
        }
        if let Err(error) = insert_chunk(index, chunk, ids, &refused, &mut result, next_id)? {
            for document in pending {
                let id = pending_ids.next().flatten();
                result
                    .failed
                    .push(refused_without_id(&document, id.as_deref(), error.clone()));
            }
            return Ok(result);
        }
    }
}

fn insert_chunk(
    index: &IndexState,
    chunk: Vec<Map>,
    ids: Vec<Option<String>>,
    refused: &[bool],
    result: &mut BatchResult,
    next_id: &NextDocumentId<'_>,
) -> Result<std::result::Result<(), NarsilError>> {
    let appended = {
        let _writer = match index.lock_writes() {
            Ok(writer) => writer,
            Err(error) => {
                for ((document, refused), id) in chunk.iter().zip(refused).zip(&ids) {
                    if !*refused {
                        result.failed.push(refused_without_id(
                            document,
                            id.as_deref(),
                            error.clone(),
                        ));
                    }
                }
                return Ok(Err(error));
            }
        };
        let mut log = PendingLog::begin(index.log())?;
        let partitions = index.partitions();
        for ((document, refused), resolved) in chunk.into_iter().zip(refused).zip(ids) {
            if *refused {
                continue;
            }
            let id = match resolved.or_else(|| provided_doc_id(&document).map(str::to_string)) {
                Some(id) => id,
                None => match next_id() {
                    Ok(id) => id,
                    Err(error) => {
                        result
                            .failed
                            .push(refused_without_id(&document, None, error));
                        continue;
                    }
                },
            };
            let outcome = require_document_within_size_limit(&document)
                .and_then(|()| require_matching_doc_id(&id, &document))
                .and_then(|()| validate_doc_id(&id))
                .and_then(|()| index.vectors.require_dimensions(&document))
                .and_then(|()| assert_capacity(index, &partitions, 0))
                .and_then(|()| apply_insert(index, &partitions, &id, document, &mut log));
            match outcome {
                Ok(()) => result.succeeded.push(id),
                Err(error) => result.failed.push(BatchFailure { doc_id: id, error }),
            }
        }
        log.append()
    };
    settle_logged(result, appended.wait());
    Ok(Ok(()))
}

/// Replaces many documents, refusing each bad one alone.
///
/// The engine checks and embeds each chunk of updates before it takes the write lock for that chunk, and reports
/// the updates that those checks refuse ahead of those that the write refuses.
pub(crate) fn update_batch(index: &IndexState, updates: Vec<(String, Map)>) -> Result<BatchResult> {
    let mut result = BatchResult::default();
    let mut pending = updates.into_iter();
    loop {
        let chunk: Vec<(String, Map)> = pending.by_ref().take(BATCH_CHUNK_DOCUMENTS).collect();
        if chunk.is_empty() {
            return Ok(result);
        }
        let mut prepared = Vec::with_capacity(chunk.len());
        for (doc_id, mut document) in chunk {
            match prepare_update(index, &doc_id, &mut document) {
                Ok(()) => prepared.push((doc_id, document)),
                Err(error) => result.failed.push(BatchFailure { doc_id, error }),
            }
        }
        let appended = {
            let _writer = match index.lock_writes() {
                Ok(writer) => writer,
                Err(error) => {
                    let unwritten = prepared
                        .into_iter()
                        .map(|(doc_id, _)| doc_id)
                        .chain(pending.map(|(doc_id, _)| doc_id));
                    refuse_each(&mut result, unwritten, &error);
                    return Ok(result);
                }
            };
            let mut log = PendingLog::begin(index.log())?;
            let partitions = index.partitions();
            for (doc_id, document) in prepared {
                match apply_update(index, &partitions, &doc_id, document, &mut log) {
                    Ok(()) => result.succeeded.push(doc_id),
                    Err(error) => result.failed.push(BatchFailure { doc_id, error }),
                }
            }
            log.append()
        };
        settle_logged(&mut result, appended.wait());
    }
}

/// Removes many documents, refusing each missing one alone.
pub(crate) fn remove_batch(index: &IndexState, doc_ids: Vec<String>) -> Result<BatchResult> {
    let mut result = BatchResult::default();
    let (appended, batched) = {
        let _writer = match index.lock_writes() {
            Ok(writer) => writer,
            Err(error) => {
                refuse_each(&mut result, doc_ids, &error);
                return Ok(result);
            }
        };
        let mut log = PendingLog::begin(index.log())?;
        let partitions = index.partitions();
        let batched = in_keyword_batch(&partitions, || {
            for doc_id in doc_ids {
                let outcome = validate_doc_id(&doc_id)
                    .and_then(|()| apply_remove(index, &partitions, &doc_id, &mut log));
                match outcome {
                    Ok(()) => result.succeeded.push(doc_id),
                    Err(error) => result.failed.push(BatchFailure { doc_id, error }),
                }
            }
            Ok(())
        });
        (log.append(), batched)
    };
    settle_logged(&mut result, appended.wait());
    batched?;
    Ok(result)
}
