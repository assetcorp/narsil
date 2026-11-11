use std::sync::Arc;

use super::EngineInner;
use super::vectors::embedding::validate_embedding_fields;
use crate::adapters::{EmbeddingAdapter, RerankAdapter};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::util::text::javascript_trim;

/// Registers an embedding adapter under `name`, after checking it against every index that names it, so that a
/// replacement either rebinds every such index or leaves the old adapter in place.
pub(crate) fn register_embedding_adapter(
    engine: &EngineInner,
    name: &str,
    adapter: Arc<dyn EmbeddingAdapter>,
) -> Result<()> {
    engine.guard_shutdown()?;
    if javascript_trim(name).is_empty() {
        return Err(NarsilError::new(
            ErrorCode::EMBEDDING_CONFIG_INVALID,
            "Embedding adapter names must be non-empty strings",
        ));
    }
    let dimensions = adapter.dimensions();
    if dimensions == 0 {
        return Err(NarsilError::new(
            ErrorCode::EMBEDDING_CONFIG_INVALID,
            format!(
                "Embedding adapter \"{name}\" dimensions must be a positive integer, got {dimensions}"
            ),
        ));
    }
    let mut registered = engine.adapters.embedding_mut();
    for (index_name, index) in engine.indexes().iter() {
        let Some(binding) = index.vectors.embedding() else {
            continue;
        };
        if binding.adapter_name() != Some(name) {
            continue;
        }
        if let Err(error) = validate_embedding_fields(&binding.fields, &index.schema, dimensions) {
            return Err(NarsilError::new(
                error.code(),
                format!(
                    "Cannot bind embedding adapter \"{name}\" to index \"{index_name}\": {}",
                    error.message()
                ),
            ));
        }
    }
    registered.insert(name.to_string(), adapter);
    Ok(())
}

/// Registers a rerank adapter under `name`, which a query's rerank step then gives.
pub(crate) fn register_rerank_adapter(
    engine: &EngineInner,
    name: &str,
    adapter: Arc<dyn RerankAdapter>,
) -> Result<()> {
    engine.guard_shutdown()?;
    if javascript_trim(name).is_empty() {
        return Err(NarsilError::new(
            ErrorCode::RERANK_CONFIG_INVALID,
            "A rerank adapter needs a non-empty string name",
        ));
    }
    engine
        .adapters
        .rerank_mut()
        .insert(name.to_string(), adapter);
    Ok(())
}
