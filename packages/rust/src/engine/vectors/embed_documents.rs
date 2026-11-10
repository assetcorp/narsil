use crate::adapters::{EmbeddingAdapter, EmbeddingPurpose};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::value::{Map, Value};

use super::embedding::{EmbeddingBinding, call_adapter, require_usable_embedding};
use super::paths::{set_value_at, value_at};

fn kind_of(value: &Value) -> &'static str {
    match value {
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        _ => "object",
    }
}

fn holds_value(document: &Map, path: &str) -> bool {
    !matches!(value_at(document, path), None | Some(Value::Null))
}

fn source_text(document: &Map, sources: &[String], target: &str) -> Result<String> {
    let mut parts: Vec<&str> = Vec::with_capacity(sources.len());
    for source in sources {
        match value_at(document, source) {
            None | Some(Value::Null) => {}
            Some(Value::String(text)) if text.is_empty() => {}
            Some(Value::String(text)) => parts.push(text),
            Some(other) => {
                return Err(NarsilError::new(
                    ErrorCode::DOC_VALIDATION_FAILED,
                    format!(
                        "Embedding source field \"{source}\" must be a string, got {}",
                        kind_of(other)
                    ),
                ));
            }
        }
    }
    if parts.is_empty() {
        return Err(NarsilError::new(
            ErrorCode::EMBEDDING_NO_SOURCE,
            format!("All source fields for embedding target \"{target}\" are missing or empty"),
        ));
    }
    Ok(parts.join("\n"))
}

fn as_value(vector: &[f32]) -> Value {
    Value::Array(
        vector
            .iter()
            .map(|&element| Value::Number(f64::from(element)))
            .collect(),
    )
}

fn embedding_failed(target: &str) -> impl FnOnce(String) -> String + '_ {
    move |message| format!("Embedding failed for field \"{target}\": {message}")
}

/// Fills each embedded vector field that `document` lacks with the vector that the adapter returns for its source
/// text, as a single write does before it checks the document.
pub(crate) fn embed_document(
    binding: &EmbeddingBinding,
    adapter: &dyn EmbeddingAdapter,
    document: &mut Map,
) -> Result<()> {
    for (target, sources) in &binding.fields {
        if holds_value(document, target) {
            continue;
        }
        let text = source_text(document, sources, target)?;
        let vector = call_adapter(|| adapter.embed(&text, EmbeddingPurpose::Document))
            .map_err(|failure| failure.into_error(embedding_failed(target)))?;
        require_usable_embedding(
            &vector,
            adapter.dimensions(),
            &format!("field \"{target}\""),
        )?;
        set_value_at(document, target, as_value(&vector));
    }
    Ok(())
}

fn is_source_error(error: &NarsilError) -> bool {
    matches!(
        error.code(),
        ErrorCode::EMBEDDING_NO_SOURCE | ErrorCode::DOC_VALIDATION_FAILED
    )
}

/// Fills the embedded vector fields of every document of a batch that `skip` leaves in, with one adapter call per
/// field.
///
/// Returns the documents that failed alone, by position, in the order that they failed. An error from the adapter
/// itself fails every document of the call, which the caller reports for each one.
pub(crate) fn embed_documents(
    binding: &EmbeddingBinding,
    adapter: &dyn EmbeddingAdapter,
    documents: &mut [Map],
    skip: &[bool],
) -> Result<Vec<(usize, NarsilError)>> {
    let mut failed: Vec<(usize, NarsilError)> = Vec::new();
    let mut refused: Vec<bool> = (0..documents.len())
        .map(|at| skip.get(at).copied().unwrap_or(false))
        .collect();
    for (target, sources) in &binding.fields {
        let mut positions: Vec<usize> = Vec::new();
        let mut texts: Vec<String> = Vec::new();
        for (at, document) in documents.iter().enumerate() {
            if refused[at] || holds_value(document, target) {
                continue;
            }
            match source_text(document, sources, target) {
                Ok(text) => {
                    positions.push(at);
                    texts.push(text);
                }
                Err(error) if is_source_error(&error) => {
                    refused[at] = true;
                    failed.push((at, error));
                }
                Err(error) => return Err(error),
            }
        }
        if texts.is_empty() {
            continue;
        }
        let vectors = call_adapter(|| adapter.embed_batch(&texts, EmbeddingPurpose::Document))
            .map_err(|failure| failure.into_error(embedding_failed(target)))?;
        if vectors.len() != texts.len() {
            return Err(NarsilError::new(
                ErrorCode::EMBEDDING_FAILED,
                format!(
                    "Adapter returned {} vectors for {} inputs on field \"{target}\"",
                    vectors.len(),
                    texts.len()
                ),
            ));
        }
        let subject = format!("field \"{target}\"");
        for vector in &vectors {
            require_usable_embedding(vector, adapter.dimensions(), &subject)?;
        }
        for (at, vector) in positions.into_iter().zip(&vectors) {
            if let Some(document) = documents.get_mut(at) {
                set_value_at(document, target, as_value(vector));
            }
        }
    }
    Ok(failed)
}
