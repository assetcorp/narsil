use crate::engine::index::IndexState;
use crate::engine::query::projection::{Projection, project_document, projection_keeps_field};
use crate::engine::vectors::paths::set_value_at;
use crate::error::Result;
use crate::value::{Map, Value};

fn vector_value(vector: Vec<f32>) -> Value {
    Value::Array(
        vector
            .into_iter()
            .map(|element| Value::Number(f64::from(element)))
            .collect(),
    )
}

pub(crate) fn listed_document(
    index: &IndexState,
    id: &str,
    projection: &Projection,
) -> Result<Option<Map>> {
    match projection {
        Projection::Nothing => return Ok(Some(Map::new())),
        Projection::Full => return index.full_document(id),
        Projection::Fields { .. } => {}
    }
    let (stored, pin) = index.published_document(id)?;
    let Some(stored) = stored else {
        return Ok(None);
    };
    let mut document = project_document(&stored, projection);
    for entry in index.vectors.fields() {
        if projection_keeps_field(projection, &entry.path)
            && let Some(vector) = entry.field.pinned_vector(id, pin.value())?
        {
            set_value_at(&mut document, &entry.path, vector_value(vector));
        }
    }
    Ok(Some(document))
}
