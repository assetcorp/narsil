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

impl IndexVectors {
    /// Fills the embedded vector fields that a written document lacks, before the engine checks the document or
    /// takes the index's write lock, so that a slow adapter holds up no other write.
    pub(crate) fn embed_for_write(&self, document: &mut Map) -> Result<()> {
        let Some(binding) = self.embedding() else {
            return Ok(());
        };
        match binding.adapter(self.adapters()) {
            Some(adapter) => embed_document(binding, adapter.as_ref(), document),
            None => require_supplied_vectors(binding, document),
        }
    }

    /// Fills the embedded vector fields of every document of a batch chunk that `refused` leaves in, and marks
    /// each document that it refuses, returning those refusals by position in the order that they happened.
    pub(crate) fn embed_chunk(
        &self,
        documents: &mut [Map],
        refused: &mut [bool],
    ) -> Vec<(usize, NarsilError)> {
        let Some(binding) = self.embedding() else {
            return Vec::new();
        };
        let mut failures = Vec::new();
        let Some(adapter) = binding.adapter(self.adapters()) else {
            for (at, document) in documents.iter().enumerate() {
                if refused.get(at).copied().unwrap_or(true) {
                    continue;
                }
                if let Err(error) = require_supplied_vectors(binding, document) {
                    failures.push((at, error));
                }
            }
            mark(refused, &failures);
            return failures;
        };
        match embed_documents(binding, adapter.as_ref(), documents, refused) {
            Ok(found) => failures = found,
            Err(error) => {
                for (at, skipped) in refused.iter().enumerate() {
                    if !skipped {
                        failures.push((at, error.clone()));
                    }
                }
            }
        }
        mark(refused, &failures);
        failures
    }
}

fn mark(refused: &mut [bool], failures: &[(usize, NarsilError)]) {
    for (at, _) in failures {
        if let Some(slot) = refused.get_mut(*at) {
            *slot = true;
        }
    }
}
