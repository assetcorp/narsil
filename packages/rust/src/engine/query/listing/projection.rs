use crate::engine::index::IndexState;
use crate::engine::query::projected::projected_document;
use crate::engine::query::projection::{Projection, Shape};
use crate::error::Result;
use crate::value::Map;

pub(crate) fn listed_document(
    index: &IndexState,
    id: &str,
    projection: &Projection,
) -> Result<Option<Map>> {
    if let Shape::Nothing = projection.shape {
        return Ok(Some(Map::new()));
    }
    projected_document(index, id, projection)
}
