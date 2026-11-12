use std::sync::Arc;

use crate::adapters::EmbeddingAdapter;
use crate::engine::constants::MAX_CALLS_ACROSS_INDEX_CHANGES;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::value::{Map, Value};

use super::IndexVectors;
use super::embed_documents::{embed_document, embed_documents};
use super::embedding::EmbeddingBinding;
use super::paths::value_at;

fn require_supplied_vectors(binding: &EmbeddingBinding, document: &Map) -> Result<()> {
    for (target, _) in &binding.fields {
        if !matches!(value_at(document, target), None | Some(Value::Null)) {
            continue;
        }
        let message = match binding.adapter_name() {
            Some(name) => format!(
                "The index embeds \"{target}\" via adapter \"{name}\", which is not registered on this engine. Register the adapter or supply the vector on the document."
            ),
            None => format!(
                "The index embeds \"{target}\" automatically but no embedding adapter is bound. Bind an adapter or supply the vector on the document."
            ),
        };
        return Err(NarsilError::new(
            ErrorCode::EMBEDDING_CONFIG_INVALID,
            message,
        ));
    }
    Ok(())
}

fn lacks_vectors(binding: &EmbeddingBinding, document: &Map) -> bool {
    binding
        .fields
        .iter()
        .any(|(target, _)| matches!(value_at(document, target), None | Some(Value::Null)))
}

fn adapter_changes_refusal(index_name: &str, embeddings: u32) -> NarsilError {
    NarsilError::new(
        ErrorCode::WORKER_BUSY,
        format!(
            "Changes to index \"{index_name}\" replaced its embedding adapter after each of {embeddings} embeddings of this write"
        ),
    )
}

struct Embedded<T> {
    adapter: Arc<dyn EmbeddingAdapter>,
    fields: Vec<(String, Vec<String>)>,
    held: T,
}

impl<T> Embedded<T> {
    fn fits(&self, binding: &EmbeddingBinding, adapter: &Arc<dyn EmbeddingAdapter>) -> bool {
        Arc::ptr_eq(&self.adapter, adapter) && self.fields == binding.fields
    }
}

/// The document of one write as its caller gave it, beside the copy that an embedding adapter filled.
///
/// A write that runs again on the index that a restore put under the name keeps the filled copy where that index
/// embeds the same fields through the same adapter, and embeds the document again from the caller's copy where it
/// has another adapter.
pub(crate) struct HeldWrite {
    document: Option<Map>,
    embedded: Option<Embedded<Map>>,
    embeddings: u32,
}

impl HeldWrite {
    pub(crate) fn new(document: Map) -> Self {
        HeldWrite {
            document: Some(document),
            embedded: None,
            embeddings: 0,
        }
    }

    /// Returns the document as its caller gave it, or `None` once the write has taken it.
    pub(crate) fn document(&self) -> Option<&Map> {
        self.document.as_ref()
    }

    /// Returns the document that the write stores: the embedded copy where an adapter filled one, else the
    /// caller's document.
    pub(crate) fn prepared(&self) -> Option<&Map> {
        match &self.embedded {
            Some(embedded) => Some(&embedded.held),
            None => self.document.as_ref(),
        }
    }

    /// Takes the document that [`HeldWrite::prepared`] returns, once the write holds the index's write lock.
    pub(crate) fn take(&mut self) -> Option<Map> {
        let caller = self.document.take();
        match self.embedded.take() {
            Some(embedded) => Some(embedded.held),
            None => caller,
        }
    }
}

/// The documents of one batch chunk as their caller gave them, beside the copies that an embedding adapter filled
/// and the documents that the embedding refused, kept as [`HeldWrite`] keeps one document.
pub(crate) struct HeldChunk {
    documents: Vec<Map>,
    embedded: Option<Embedded<FilledChunk>>,
    embeddings: u32,
}

struct FilledChunk {
    documents: Vec<Map>,
    failures: Vec<(usize, NarsilError)>,
}

impl HeldChunk {
    pub(crate) fn new(documents: Vec<Map>) -> Self {
        HeldChunk {
            documents,
            embedded: None,
            embeddings: 0,
        }
    }

    /// Returns the documents as their caller gave them.
    pub(crate) fn documents(&self) -> &[Map] {
        &self.documents
    }

    /// Takes the documents that the chunk writes: the embedded copies where an adapter filled them, else the
    /// caller's documents.
    pub(crate) fn take(&mut self) -> Vec<Map> {
        let caller = std::mem::take(&mut self.documents);
        match self.embedded.take() {
            Some(embedded) => embedded.held.documents,
            None => caller,
        }
    }
}

#[derive(Default)]
pub(crate) struct ChunkRefusals {
    pub(crate) lasting: Vec<(usize, NarsilError)>,
    pub(crate) embedded: Vec<(usize, NarsilError)>,
}

impl ChunkRefusals {
    fn lasting(refused: &mut [bool], lasting: Vec<(usize, NarsilError)>) -> Self {
        mark(refused, &lasting);
        ChunkRefusals {
            lasting,
            embedded: Vec::new(),
        }
    }
}

fn mark(refused: &mut [bool], failures: &[(usize, NarsilError)]) {
    for (at, _) in failures {
        if let Some(slot) = refused.get_mut(*at) {
            *slot = true;
        }
    }
}

fn fail_each(refused: &[bool], error: &NarsilError) -> Vec<(usize, NarsilError)> {
    refused
        .iter()
        .enumerate()
        .filter(|(_, skipped)| !**skipped)
        .map(|(at, _)| (at, error.clone()))
        .collect()
}

impl IndexVectors {
    /// Fills the embedded vector fields that the document of `held` lacks, before the engine checks the document
    /// or takes the index's write lock, so that a slow adapter holds up no other write.
    ///
    /// Fails with `WORKER_BUSY` where restores have changed the adapter after each of
    /// [`MAX_CALLS_ACROSS_INDEX_CHANGES`] embeddings of the write.
    pub(crate) fn embed_held_write(&self, index_name: &str, held: &mut HeldWrite) -> Result<()> {
        let Some(document) = &held.document else {
            return Ok(());
        };
        let Some(binding) = self.embedding() else {
            held.embedded = None;
            return Ok(());
        };
        let Some(adapter) = binding.adapter(self.adapters()) else {
            held.embedded = None;
            return require_supplied_vectors(binding, document);
        };
        if held
            .embedded
            .as_ref()
            .is_some_and(|embedded| embedded.fits(binding, &adapter))
        {
            return Ok(());
        }
        held.embedded = None;
        if !lacks_vectors(binding, document) {
            return Ok(());
        }
        if held.embeddings >= MAX_CALLS_ACROSS_INDEX_CHANGES {
            return Err(adapter_changes_refusal(index_name, held.embeddings));
        }
        held.embeddings += 1;
        let mut filled = document.clone();
        embed_document(binding, adapter.as_ref(), &mut filled)?;
        held.embedded = Some(Embedded {
            adapter,
            fields: binding.fields.clone(),
            held: filled,
        });
        Ok(())
    }

    /// Fills the embedded vector fields of every document of a batch chunk that `refused` leaves in, and marks
    /// each document that it refuses, returning those refusals by position in the order that they happened.
    ///
    /// Refuses every document that `refused` leaves in with `WORKER_BUSY` where restores have changed the adapter
    /// after each of [`MAX_CALLS_ACROSS_INDEX_CHANGES`] embeddings of the chunk.
    pub(crate) fn embed_held_chunk(
        &self,
        index_name: &str,
        held: &mut HeldChunk,
        refused: &mut [bool],
    ) -> ChunkRefusals {
        let Some(binding) = self.embedding() else {
            held.embedded = None;
            return ChunkRefusals::default();
        };
        let Some(adapter) = binding.adapter(self.adapters()) else {
            held.embedded = None;
            let failures: Vec<(usize, NarsilError)> = held
                .documents
                .iter()
                .enumerate()
                .filter(|(at, _)| !refused.get(*at).copied().unwrap_or(true))
                .filter_map(|(at, document)| {
                    require_supplied_vectors(binding, document)
                        .err()
                        .map(|error| (at, error))
                })
                .collect();
            return ChunkRefusals::lasting(refused, failures);
        };
        let fits = held
            .embedded
            .as_ref()
            .is_some_and(|embedded| embedded.fits(binding, &adapter));
        if !fits {
            held.embedded = None;
            let lacking = held
                .documents
                .iter()
                .enumerate()
                .any(|(at, document)| !refused[at] && lacks_vectors(binding, document));
            if !lacking {
                return ChunkRefusals::default();
            }
            if held.embeddings >= MAX_CALLS_ACROSS_INDEX_CHANGES {
                let refusal = adapter_changes_refusal(index_name, held.embeddings);
                let failures = fail_each(refused, &refusal);
                return ChunkRefusals::lasting(refused, failures);
            }
            held.embeddings += 1;
            let mut filled = held.documents.clone();
            let failures = match embed_documents(binding, adapter.as_ref(), &mut filled, refused) {
                Ok(failures) => failures,
                Err(error) => {
                    let failures = fail_each(refused, &error);
                    return ChunkRefusals::lasting(refused, failures);
                }
            };
            held.embedded = Some(Embedded {
                adapter,
                fields: binding.fields.clone(),
                held: FilledChunk {
                    documents: filled,
                    failures,
                },
            });
        }
        let embedded: Vec<(usize, NarsilError)> = held
            .embedded
            .iter()
            .flat_map(|embedded| &embedded.held.failures)
            .filter(|(at, _)| !refused.get(*at).copied().unwrap_or(true))
            .cloned()
            .collect();
        mark(refused, &embedded);
        ChunkRefusals {
            lasting: Vec::new(),
            embedded,
        }
    }
}
