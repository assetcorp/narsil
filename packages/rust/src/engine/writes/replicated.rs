use std::sync::Arc;

use super::{
    apply_insert, apply_remove, apply_update, assert_capacity, require_required_fields,
    validate_document,
};
use crate::engine::durable::log::PendingLog;
use crate::engine::index::IndexState;
use crate::error::Result;
use crate::index::partition::Partition;
use crate::value::Map;

/// Applies a primary's insert with the checks of a standalone insert, while the caller holds the write lock. The
/// caller logs the write under the number and the term that the primary assigns.
pub(crate) fn apply_primary_insert(
    index: &IndexState,
    partitions: &[Arc<Partition>],
    id: &str,
    document: Map,
) -> Result<()> {
    index.vectors.require_dimensions(&document)?;
    assert_capacity(index, partitions, 0)?;
    apply_insert(
        index,
        partitions,
        id,
        document,
        &mut PendingLog::begin(None)?,
    )
}

/// Applies a primary's update with the checks of a standalone update, as [`apply_primary_insert`] applies an
/// insert.
pub(crate) fn apply_primary_update(
    index: &IndexState,
    partitions: &[Arc<Partition>],
    id: &str,
    document: Map,
) -> Result<()> {
    apply_update(
        index,
        partitions,
        id,
        document,
        &mut PendingLog::begin(None)?,
    )
}

/// Applies a primary's removal with the checks of a standalone removal, as [`apply_primary_insert`] applies an
/// insert.
pub(crate) fn apply_primary_remove(
    index: &IndexState,
    partitions: &[Arc<Partition>],
    id: &str,
) -> Result<()> {
    apply_remove(index, partitions, id, &mut PendingLog::begin(None)?)
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
