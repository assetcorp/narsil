use std::sync::Arc;

use super::{already_exists, assert_capacity, require_required_fields, validated};
use crate::engine::index::IndexState;
use crate::error::Result;
use crate::index::partition::Partition;
use crate::schema::validate_document;
use crate::value::Map;

/// Runs the checks of an insert that a primary makes under the write lock before it applies the document.
pub(crate) fn check_primary_insert(
    index: &IndexState,
    partitions: &[Arc<Partition>],
    partition: usize,
    id: &str,
    document: &Map,
) -> Result<()> {
    if index.locate(partitions, id)?.is_some() {
        return Err(already_exists(id, partition));
    }
    index.vectors.require_dimensions(document)?;
    validated(index, document)?;
    assert_capacity(index, partitions, 0)
}

/// Runs the checks of an update that a primary makes under the write lock before it applies the document.
pub(crate) fn check_primary_update(
    index: &IndexState,
    partitions: &[Arc<Partition>],
    id: &str,
    document: &Map,
) -> Result<()> {
    index.vectors.require_dimensions(document)?;
    if index.locate(partitions, id)?.is_none() {
        return Err(index.not_found(id));
    }
    validated(index, document)
}

/// Runs the checks of a document write that a primary makes before it takes the write lock.
pub(crate) fn check_primary_document(index: &IndexState, document: &Map) -> Result<()> {
    require_required_fields(index, document)
}

/// Refuses a replicated document that the index cannot index, and leaves every other rule to the primary that
/// accepted the document.
pub(crate) fn check_replicated_document(index: &IndexState, document: &Map) -> Result<()> {
    index.vectors.require_dimensions(document)?;
    validate_document(document, &index.schema, index.pattern_value_limit())
}
