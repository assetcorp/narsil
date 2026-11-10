use super::constants::{MAX_SORT_FIELD_NAME_LENGTH, MAX_SORT_FIELDS};
use crate::engine::query::javascript::{utf16_length, write_json_text};
use crate::engine::query::params::{SortDirection, SortField, SortMode};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::ordering::default_sort_mode;

fn direction_name(direction: SortDirection) -> &'static str {
    match direction {
        SortDirection::Asc => "asc",
        SortDirection::Desc => "desc",
    }
}

fn mode_name(mode: SortMode) -> &'static str {
    match mode {
        SortMode::Min => "min",
        SortMode::Max => "max",
        SortMode::Avg => "avg",
        SortMode::Median => "median",
    }
}

pub(crate) fn sort_signature_of(sort: Option<&[SortField]>) -> Result<Option<String>> {
    let Some(fields) = sort.filter(|fields| !fields.is_empty()) else {
        return Ok(None);
    };
    if fields.len() > MAX_SORT_FIELDS {
        return Err(NarsilError::new(
            ErrorCode::SEARCH_INVALID_FIELD,
            format!(
                "A sort names at most {MAX_SORT_FIELDS} fields, because the paging cursor carries one value per field"
            ),
        ));
    }
    if fields
        .iter()
        .any(|entry| utf16_length(&entry.field) > MAX_SORT_FIELD_NAME_LENGTH)
    {
        return Err(NarsilError::new(
            ErrorCode::SEARCH_INVALID_FIELD,
            format!(
                "A sort field name holds at most {MAX_SORT_FIELD_NAME_LENGTH} characters, because the paging cursor carries the sort with every page"
            ),
        ));
    }
    let mut signature = String::from("[");
    for (at, entry) in fields.iter().enumerate() {
        if at > 0 {
            signature.push(',');
        }
        signature.push('[');
        write_json_text(&mut signature, &entry.field);
        signature.push_str(",\"");
        signature.push_str(direction_name(entry.direction));
        signature.push('"');
        let mode = entry.mode.unwrap_or(default_sort_mode(entry.direction));
        if mode != default_sort_mode(entry.direction) {
            signature.push_str(",\"");
            signature.push_str(mode_name(mode));
            signature.push('"');
        }
        signature.push(']');
    }
    signature.push(']');
    Ok(Some(signature))
}
