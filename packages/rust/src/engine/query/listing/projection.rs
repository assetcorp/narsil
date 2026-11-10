use std::sync::Arc;

use crate::engine::constants::DOCUMENT_READ_ATTEMPTS;
use crate::engine::index::IndexState;
use crate::engine::query::projection::{Projection, project_document, projection_keeps_field};
use crate::engine::vectors::paths::set_value_at;
use crate::error::Result;
use crate::index::partition::Partition;
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
    partitions: &[Arc<Partition>],
    id: &str,
    projection: &Projection,
) -> Result<Option<Map>> {
    match projection {
        Projection::Nothing => return Ok(Some(Map::new())),
        Projection::Full => return index.full_document(partitions, id),
        Projection::Fields { .. } => {}
    }
    let pin = index.vectors.sequence().pin()?;
    let mut attempt = 1;
    loop {
        let Some(at) = index.locate(partitions, id)? else {
            return Ok(None);
        };
        let Some(partition) = partitions.get(at) else {
            return Ok(None);
        };
        let snapshot = partition.snapshot();
        let Some(stored) = snapshot.document(id)? else {
            return Ok(None);
        };
        let vectors: Vec<(&str, Vec<f32>)> = index
            .vectors
            .fields()
            .iter()
            .filter(|entry| projection_keeps_field(projection, &entry.path))
            .filter_map(|entry| {
                Some((
                    entry.path.as_str(),
                    entry.field.pinned_vector(id, pin.value())?,
                ))
            })
            .collect();
        if attempt >= DOCUMENT_READ_ATTEMPTS || Arc::ptr_eq(&snapshot, &partition.snapshot()) {
            let mut document = project_document(&stored, projection);
            for (path, vector) in vectors {
                set_value_at(&mut document, path, vector_value(vector));
            }
            return Ok(Some(document));
        }
        attempt += 1;
    }
}
