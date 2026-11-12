use std::borrow::Cow;
use std::sync::Arc;

use super::constants::MAX_QUERY_EMBEDDINGS;
use super::params::{QueryParams, VectorQuery};
use crate::adapters::{EmbeddingAdapter, EmbeddingPurpose};
use crate::engine::index::IndexState;
use crate::engine::index_lifecycle::PreparedRead;
use crate::engine::vectors::embedding::{call_adapter, require_usable_embedding};
use crate::error::{ErrorCode, NarsilError, Result};

fn query_adapter_missing(index: &IndexState) -> NarsilError {
    let message = match index
        .vectors
        .embedding()
        .and_then(|binding| binding.adapter_name())
    {
        Some(name) => format!(
            "Vector query with 'text' needs embedding adapter \"{name}\", which is not registered on this engine. Register it with registerEmbeddingAdapter or supply a raw vector."
        ),
        None => {
            "Vector query with 'text' requires an embedding adapter on the index or instance".into()
        }
    };
    NarsilError::new(ErrorCode::EMBEDDING_CONFIG_INVALID, message)
}

pub(crate) struct EmbeddedQuery<'a> {
    adapter: Option<Arc<dyn EmbeddingAdapter>>,
    embeddings: u32,
    superseded: bool,
    pub(crate) params: Cow<'a, QueryParams>,
}

impl EmbeddedQuery<'_> {
    fn fits(&self, index: &IndexState) -> bool {
        let Some(used) = &self.adapter else {
            return true;
        };
        index
            .vectors
            .embedding_adapter()
            .is_some_and(|current| Arc::ptr_eq(used, &current))
    }
}

impl PreparedRead for EmbeddedQuery<'_> {
    fn holds_for(&self, index: &IndexState) -> bool {
        self.fits(index)
    }

    fn supersede(&mut self) {
        self.superseded = true;
    }
}

/// Turns a vector clause's `text` into its `value` through the index's embedding adapter, and returns the query
/// unchanged where it gives no text. Where `earlier` holds a query that the same adapter embedded and that a read
/// never found superseded, it comes back as it stands, and where the adapter has changed before each of
/// [`MAX_QUERY_EMBEDDINGS`] embeddings, the query fails with `WORKER_BUSY`.
pub(crate) fn resolve_vector_text<'a>(
    index: &IndexState,
    params: &'a QueryParams,
    earlier: Option<EmbeddedQuery<'a>>,
) -> Result<EmbeddedQuery<'a>> {
    let embeddings = match earlier {
        Some(earlier) if !earlier.superseded && earlier.fits(index) => return Ok(earlier),
        Some(earlier) => earlier.embeddings,
        None => 0,
    };
    if embeddings >= MAX_QUERY_EMBEDDINGS {
        return Err(NarsilError::new(
            ErrorCode::WORKER_BUSY,
            format!(
                "The embedding adapter of index \"{}\" changed after each of {embeddings} query embeddings",
                index.name
            ),
        ));
    }
    let unchanged = EmbeddedQuery {
        adapter: None,
        embeddings,
        superseded: false,
        params: Cow::Borrowed(params),
    };
    let Some(clause) = &params.vector else {
        return Ok(unchanged);
    };
    let Some(text) = &clause.text else {
        return Ok(unchanged);
    };
    if clause.value.is_some() {
        return Err(NarsilError::new(
            ErrorCode::EMBEDDING_CONFIG_INVALID,
            "Vector query cannot have both 'text' and 'value'",
        ));
    }
    let Some(adapter) = index.vectors.embedding_adapter() else {
        return Err(query_adapter_missing(index));
    };
    if text.is_empty() {
        return Err(NarsilError::new(
            ErrorCode::DOC_VALIDATION_FAILED,
            "Vector query 'text' must not be empty",
        ));
    }
    let vector =
        call_adapter(|| adapter.embed(text, EmbeddingPurpose::Query)).map_err(|failure| {
            failure.into_error(|message| {
                format!("The embedding adapter cannot embed the query: {message}")
            })
        })?;
    require_usable_embedding(&vector, adapter.dimensions(), "query")?;
    let mut resolved = params.clone();
    resolved.vector = Some(VectorQuery {
        value: Some(vector),
        text: None,
        ..clause.clone()
    });
    Ok(EmbeddedQuery {
        adapter: Some(adapter),
        embeddings: embeddings + 1,
        superseded: false,
        params: Cow::Owned(resolved),
    })
}
