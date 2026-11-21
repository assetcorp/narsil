use std::sync::Arc;

use super::projection::{Projection, Shape, project_document};
use crate::engine::index::IndexState;
use crate::engine::vectors::paths::{set_value_at, take_value_at, value_at};
use crate::error::Result;
use crate::pins::Pin;
use crate::value::{Map, Value};

fn vector_value(vector: Vec<f32>) -> Value {
    Value::Array(
        vector
            .into_iter()
            .map(|element| Value::Number(f64::from(element)))
            .collect(),
    )
}

fn holds_left_out_vector(index: &IndexState, projection: &Projection, document: &Map) -> bool {
    index
        .vectors
        .fields()
        .iter()
        .enumerate()
        .any(|(at, entry)| {
            !projection.returns_vector(at) && value_at(document, &entry.path).is_some()
        })
}

fn leave_out_vectors(index: &IndexState, projection: &Projection, document: &mut Map) {
    for (at, entry) in index.vectors.fields().iter().enumerate() {
        if !projection.returns_vector(at) {
            take_value_at(document, &entry.path);
        }
    }
}

fn attach_returned_vectors(
    index: &IndexState,
    projection: &Projection,
    id: &str,
    pin: &Pin,
    document: &mut Map,
) -> Result<()> {
    for (at, entry) in index.vectors.fields().iter().enumerate() {
        if projection.returns_vector(at)
            && let Some(vector) = entry.field.pinned_vector(id, pin.value())?
        {
            set_value_at(document, &entry.path, vector_value(vector));
        }
    }
    Ok(())
}

pub(crate) fn hit_document(
    index: &IndexState,
    projection: &Projection,
    id: &str,
    pin: &Pin,
    stored: Arc<Map>,
) -> Result<Arc<Map>> {
    if index.vectors.is_empty() {
        return Ok(stored);
    }
    if !projection.returns_any_vector() && !holds_left_out_vector(index, projection, &stored) {
        return Ok(stored);
    }
    let mut document = Arc::unwrap_or_clone(stored);
    leave_out_vectors(index, projection, &mut document);
    attach_returned_vectors(index, projection, id, pin, &mut document)?;
    Ok(Arc::new(document))
}

pub(crate) fn projected_document(
    index: &IndexState,
    id: &str,
    projection: &Projection,
) -> Result<Option<Map>> {
    if let Shape::Full = projection.shape
        && !projection.leaves_out_any_vector()
    {
        return index.full_document(id);
    }
    let (stored, pin) = index.published_document(id)?;
    let Some(stored) = stored else {
        return Ok(None);
    };
    let mut document = match projection.shape {
        Shape::Nothing => return Ok(Some(Map::new())),
        Shape::Full => Arc::unwrap_or_clone(stored),
        Shape::Fields { .. } => project_document(&stored, &projection.shape),
    };
    leave_out_vectors(index, projection, &mut document);
    attach_returned_vectors(index, projection, id, &pin, &mut document)?;
    Ok(Some(document))
}
