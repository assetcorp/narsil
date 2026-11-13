use super::{
    BatchFailure, BatchResult, NextDocumentId, apply_insert, apply_remove, apply_update,
    assert_capacity, prepare_update, provided_doc_id, require_matching_doc_id,
    require_required_fields,
};
use crate::config::validate_doc_id;
use crate::engine::constants::BATCH_CHUNK_DOCUMENTS;
use crate::engine::durable::log::{LogFailure, PendingLog};
use crate::engine::index::IndexState;
use crate::engine::memory::MemoryGuard;
use crate::engine::vectors::{HeldChunk, HeldWrite};
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

/// What one try at writing a batch chunk did.
pub(crate) enum ChunkWrite {
    /// The chunk held the write lock, and the batch's result holds every document of it.
    Written,
    /// The write lock refused the chunk with `error`. The caller can write the chunk again on the index that took
    /// the name, or add `failed`, which holds every document of the chunk, to the batch's result.
    Refused {
        error: NarsilError,
        failed: Vec<BatchFailure>,
    },
}

/// One chunk of a batch insert, with the ID that a plugin hook already saw for each document where one did.
pub(crate) struct InsertChunk {
    held: HeldChunk,
    ids: Vec<Option<String>>,
    refused: Vec<bool>,
    refusals: Vec<BatchFailure>,
}

impl InsertChunk {
    /// Refuses every document of the chunk with `error`.
    pub(crate) fn refuse(self, error: &NarsilError, result: &mut BatchResult) {
        result.failed.extend(self.refusals);
        let documents = self.held.documents().iter().zip(&self.refused);
        for ((document, refused), id) in documents.zip(&self.ids) {
            if !*refused {
                result
                    .failed
                    .push(refused_without_id(document, id.as_deref(), error.clone()));
            }
        }
    }
}

/// Splits a batch insert into chunks of [`BATCH_CHUNK_DOCUMENTS`] documents. `resolved_ids` gives, by position,
/// the ID that a plugin hook already saw for a document, and the engine resolves the ID of every document past its
/// end, or with `None` there, from the document under the write lock.
pub(crate) fn insert_chunks(
    documents: Vec<Map>,
    resolved_ids: Vec<Option<String>>,
) -> Vec<InsertChunk> {
    let mut chunks = Vec::new();
    let mut pending = documents.into_iter();
    let mut pending_ids = resolved_ids.into_iter();
    loop {
        let documents: Vec<Map> = pending.by_ref().take(BATCH_CHUNK_DOCUMENTS).collect();
        if documents.is_empty() {
            return chunks;
        }
        let ids = documents
            .iter()
            .map(|_| pending_ids.next().flatten())
            .collect();
        chunks.push(InsertChunk {
            refused: vec![false; documents.len()],
            held: HeldChunk::new(documents),
            ids,
            refusals: Vec::new(),
        });
    }
}

/// Inserts one chunk of a batch, refusing each bad document alone.
///
/// The engine checks the required fields and embeds the text of the chunk before it takes the write lock, so that
/// an embedding call holds up no other write. Where the lock refuses the chunk, the chunk keeps its documents and
/// their embedded copies, so that the caller can write it again on the index that a restore put under the name.
pub(crate) fn insert_chunk(
    index: &IndexState,
    memory: &MemoryGuard,
    chunk: &mut InsertChunk,
    result: &mut BatchResult,
    next_id: &NextDocumentId<'_>,
) -> Result<ChunkWrite> {
    let documents = chunk.held.documents();
    let checked = documents.iter().zip(chunk.refused.iter_mut());
    for ((document, refused), id) in checked.zip(&chunk.ids) {
        if *refused {
            continue;
        }
        if let Err(error) = require_required_fields(index, document) {
            *refused = true;
            let refusal = refused_without_id(document, id.as_deref(), error);
            chunk.refusals.push(refusal);
        }
    }
    let mut failed = chunk.refusals.clone();
    let mut refused = chunk.refused.clone();
    let refusals = index
        .vectors
        .embed_held_chunk(&index.name, &mut chunk.held, &mut refused);
    let documents = chunk.held.documents();
    for (at, error) in refusals.lasting {
        let (Some(document), Some(slot)) = (documents.get(at), chunk.refused.get_mut(at)) else {
            continue;
        };
        *slot = true;
        let id = chunk.ids.get(at).and_then(Option::as_deref);
        let refusal = refused_without_id(document, id, error);
        chunk.refusals.push(refusal.clone());
        failed.push(refusal);
    }
    for (at, error) in refusals.embedded {
        if let Some(document) = documents.get(at) {
            let id = chunk.ids.get(at).and_then(Option::as_deref);
            failed.push(refused_without_id(document, id, error));
        }
    }
    let appended = {
        let _writer = match index.lock_writes().and_then(|writer| {
            memory.refuse_while_full(&index.name)?;
            Ok(writer)
        }) {
            Ok(writer) => writer,
            Err(error) => {
                for ((document, refused), id) in documents.iter().zip(&refused).zip(&chunk.ids) {
                    if !*refused {
                        failed.push(refused_without_id(document, id.as_deref(), error.clone()));
                    }
                }
                return Ok(ChunkWrite::Refused { error, failed });
            }
        };
        result.failed.append(&mut failed);
        let documents = chunk.held.take();
        let ids = std::mem::take(&mut chunk.ids);
        let mut log = PendingLog::begin(index.log())?;
        let partitions = index.partitions();
        for ((document, refused), resolved) in documents.into_iter().zip(&refused).zip(ids) {
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
    Ok(ChunkWrite::Written)
}

/// One chunk of a batch update, each update with its ID.
pub(crate) struct UpdateChunk {
    updates: Vec<(String, HeldWrite)>,
}

impl UpdateChunk {
    /// Refuses every update of the chunk with `error`.
    pub(crate) fn refuse(self, error: &NarsilError, result: &mut BatchResult) {
        refuse_each(
            result,
            self.updates.into_iter().map(|(doc_id, _)| doc_id),
            error,
        );
    }
}

/// Splits a batch update into chunks of [`BATCH_CHUNK_DOCUMENTS`] updates.
pub(crate) fn update_chunks(updates: Vec<(String, Map)>) -> Vec<UpdateChunk> {
    let mut chunks = Vec::new();
    let mut pending = updates.into_iter();
    loop {
        let updates: Vec<(String, HeldWrite)> = pending
            .by_ref()
            .take(BATCH_CHUNK_DOCUMENTS)
            .map(|(doc_id, document)| (doc_id, HeldWrite::new(document)))
            .collect();
        if updates.is_empty() {
            return chunks;
        }
        chunks.push(UpdateChunk { updates });
    }
}

/// Replaces the documents of one chunk of a batch update, refusing each bad update alone.
///
/// The engine checks and embeds each update before it takes the write lock for the chunk, and reports the updates
/// that those checks refuse ahead of those that the write refuses. Where the lock refuses the chunk, the chunk keeps
/// its updates as [`insert_chunk`] keeps its documents.
pub(crate) fn update_chunk(
    index: &IndexState,
    memory: &MemoryGuard,
    chunk: &mut UpdateChunk,
    result: &mut BatchResult,
) -> Result<ChunkWrite> {
    let mut failed = Vec::new();
    let mut prepared = vec![false; chunk.updates.len()];
    for ((doc_id, held), prepared) in chunk.updates.iter_mut().zip(prepared.iter_mut()) {
        match prepare_update(index, doc_id, held) {
            Ok(()) => *prepared = true,
            Err(error) => failed.push(BatchFailure {
                doc_id: doc_id.clone(),
                error,
            }),
        }
    }
    let appended = {
        let _writer = match index.lock_writes().and_then(|writer| {
            memory.refuse_while_full(&index.name)?;
            Ok(writer)
        }) {
            Ok(writer) => writer,
            Err(error) => {
                for ((doc_id, _), prepared) in chunk.updates.iter().zip(&prepared) {
                    if *prepared {
                        failed.push(BatchFailure {
                            doc_id: doc_id.clone(),
                            error: error.clone(),
                        });
                    }
                }
                return Ok(ChunkWrite::Refused { error, failed });
            }
        };
        result.failed.append(&mut failed);
        let mut log = PendingLog::begin(index.log())?;
        let partitions = index.partitions();
        for ((doc_id, held), prepared) in chunk.updates.iter_mut().zip(&prepared) {
            if !*prepared {
                continue;
            }
            let Some(document) = held.take() else {
                continue;
            };
            match apply_update(index, &partitions, doc_id, document, &mut log) {
                Ok(()) => result.succeeded.push(doc_id.clone()),
                Err(error) => result.failed.push(BatchFailure {
                    doc_id: doc_id.clone(),
                    error,
                }),
            }
        }
        log.append()
    };
    settle_logged(result, appended.wait());
    Ok(ChunkWrite::Written)
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
