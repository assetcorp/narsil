use narsil::{Map, SortDirection, SortField, SortMode, Value};

use super::payload::{invalid, string_field};
use crate::constants::{MAX_FIELD_NAME_LENGTH, MAX_SORT_FIELDS};
use crate::error::{ClusterResult, codes};

const SORT_MODE_NAMES: &str = "min, max, avg, median";

fn sort_mode(name: &str) -> Option<SortMode> {
    match name {
        "min" => Some(SortMode::Min),
        "max" => Some(SortMode::Max),
        "avg" => Some(SortMode::Avg),
        "median" => Some(SortMode::Median),
        _ => None,
    }
}

fn sort_entry(entry: &Map, at: usize, payload_name: &str, label: &str) -> ClusterResult<SortField> {
    let field = string_field(
        entry.get("field"),
        &format!("{label}[{at}].field"),
        MAX_FIELD_NAME_LENGTH,
        codes::SEARCH_INVALID_FIELD,
    )?;
    let direction = match entry.get("direction") {
        Some(Value::String(direction)) if direction == "asc" => SortDirection::Asc,
        Some(Value::String(direction)) if direction == "desc" => SortDirection::Desc,
        _ => {
            return Err(invalid(
                codes::SEARCH_INVALID_MODE,
                format!(
                    "Invalid {payload_name}: \"{label}[{at}].direction\" must be one of: asc, desc"
                ),
            ));
        }
    };
    let mode = match entry.get("mode") {
        None | Some(Value::Null) => None,
        Some(Value::String(name)) if sort_mode(name).is_some() => sort_mode(name),
        Some(_) => {
            return Err(invalid(
                codes::SEARCH_INVALID_MODE,
                format!(
                    "Invalid {payload_name}: \"{label}[{at}].mode\" must be one of: {SORT_MODE_NAMES}"
                ),
            ));
        }
    };
    Ok(SortField {
        field,
        direction,
        mode,
    })
}

pub(super) fn sort_fields(
    value: Option<&Value>,
    payload_name: &str,
    label: &str,
) -> ClusterResult<Vec<SortField>> {
    let items = match value {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(items)) => items,
        Some(_) => {
            return Err(invalid(
                codes::CONFIG_INVALID,
                format!("Invalid {payload_name}: \"{label}\" must be an array or null"),
            ));
        }
    };
    if items.len() > MAX_SORT_FIELDS {
        return Err(invalid(
            codes::SEARCH_INVALID_FIELD,
            format!(
                "Invalid {payload_name}: \"{label}\" exceeds maximum length of {MAX_SORT_FIELDS}"
            ),
        )
        .with_detail("length", Value::from(items.len()))
        .with_detail("limit", Value::from(MAX_SORT_FIELDS)));
    }
    items
        .iter()
        .enumerate()
        .map(|(at, item)| match item {
            Value::Object(entry) => sort_entry(entry, at, payload_name, label),
            _ => Err(invalid(
                codes::CONFIG_INVALID,
                format!("Invalid {payload_name}: \"{label}[{at}]\" must be an object"),
            )),
        })
        .collect()
}

pub(super) fn wire_sort_values(document: Option<&Map>, sort: &[SortField]) -> ClusterResult<Value> {
    let values = match document {
        Some(document) => narsil::partitions::document_sort_values(document, sort)?,
        None => vec![Value::Null; sort.len()],
    };
    Ok(Value::Array(values))
}
