mod fields;
mod size;
mod storable;

use super::compiled::CompiledSchema;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::value::{Map, Value};
use fields::validate_level;
use storable::{require_id_field, walk_entries};

pub(crate) use size::require_document_within_size_limit;

pub(crate) const MAX_DOCUMENT_NESTING_DEPTH: usize = 32;
pub(crate) const MAX_DOCUMENT_BYTES: usize = 16_777_216;
pub(crate) const DEFAULT_PATTERN_VALUE_LIMIT: usize = 8_192;

fn failed(message: impl Into<String>) -> NarsilError {
    NarsilError::new(ErrorCode::DOC_VALIDATION_FAILED, message.into())
}

fn kind_of(value: &Value) -> &'static str {
    match value {
        Value::Null => "object",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Bytes(_) | Value::Timestamp(_) | Value::Object(_) => "object",
    }
}

fn typeof_of(value: &Value) -> &'static str {
    match value {
        Value::Array(_) => "object",
        other => kind_of(other),
    }
}

/// Checks a document against the schema, as every insert and update must before it changes the index.
pub(crate) fn validate_document(
    document: &Map,
    schema: &CompiledSchema,
    pattern_limit: usize,
) -> Result<()> {
    require_id_field(document)?;
    walk_entries(document, "", 0, &schema.vector_paths)?;
    validate_level(document, &schema.levels, pattern_limit)
}

fn collect_extra_fields(document: &Map, definition: &Map, prefix: &str, extras: &mut Vec<String>) {
    for (key, value) in document.iter() {
        if key == "id" {
            continue;
        }
        let path = if prefix.is_empty() {
            key.clone()
        } else {
            format!("{prefix}.{key}")
        };
        match definition.get(key) {
            None => extras.push(path),
            Some(Value::Object(nested)) => {
                if let Value::Object(inner) = value {
                    collect_extra_fields(inner, nested, &path, extras);
                }
            }
            Some(_) => {}
        }
    }
}

/// Raises `DOC_VALIDATION_FAILED` for a document that holds a field the schema lacks, as a strict index requires.
pub(crate) fn validate_document_strict(document: &Map, schema: &CompiledSchema) -> Result<()> {
    let mut extras = Vec::new();
    collect_extra_fields(document, &schema.definition, "", &mut extras);
    if extras.is_empty() {
        return Ok(());
    }
    Err(failed(format!(
        "Document contains fields not defined in schema: {}",
        extras.join(", ")
    )))
}

fn nested_value<'a>(document: &'a Map, path: &str) -> Option<&'a Value> {
    let mut segments = path.split('.');
    let first = segments.next()?;
    let mut current = document.get(first)?;
    for segment in segments {
        current = current.as_object()?.get(segment)?;
    }
    Some(current)
}

/// Raises `DOC_MISSING_REQUIRED_FIELD` for the first required field that a document leaves out or sets to null.
pub(crate) fn validate_required_fields(document: &Map, required: &[String]) -> Result<()> {
    for field in required {
        if matches!(nested_value(document, field), None | Some(Value::Null)) {
            return Err(NarsilError::new(
                ErrorCode::DOC_MISSING_REQUIRED_FIELD,
                format!("Document is missing required field \"{field}\""),
            ));
        }
    }
    Ok(())
}
