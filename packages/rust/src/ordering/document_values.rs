use super::{SortValues, default_sort_mode, push_reduced};
use crate::engine::SortField;
use crate::error::Result;
use crate::index::core_values::CoreStoredValues;
use crate::index::stored_values::path_value;
use crate::value::{Map, Value};

/// Returns the value that each field of `sort` orders `document` by, reduced to one value under the field's sort
/// mode, or `null` where the document holds no value that the field can sort by.
///
/// A cluster data node sends these values with each entry that it ranks, so that the coordinator merges every
/// node's entries in the order that one engine would give them.
pub fn document_sort_values(document: &Map, sort: &[SortField]) -> Result<Vec<Value>> {
    let mut reduced = Vec::with_capacity(sort.len());
    for field in sort {
        let mode = field
            .mode
            .unwrap_or_else(|| default_sort_mode(field.direction));
        let mut stored = CoreStoredValues::default();
        stored.push(path_value(document, &field.field).as_deref())?;
        let mut values = SortValues::default();
        push_reduced(&stored, 0, mode, &mut values)?;
        reduced.push(values.value(0).cursor_value());
    }
    Ok(reduced)
}
