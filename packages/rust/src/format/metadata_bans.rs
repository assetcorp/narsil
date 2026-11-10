use crate::error::{ErrorCode, NarsilError, Result};
use crate::value::Value;

/// Reads the `banned_queries` field of the index metadata, refusing with `CONFIG_INVALID` a field that is not a
/// list of strings, and returning `None` for an absent or empty list.
pub(crate) fn ban_list_of(value: Option<&Value>) -> Result<Option<Vec<String>>> {
    let items = match value {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Array(items)) => items,
        Some(_) => return Err(not_a_list()),
    };
    let phrases = items
        .iter()
        .map(|item| item.as_str().map(str::to_string).ok_or_else(not_a_list))
        .collect::<Result<Vec<String>>>()?;
    Ok((!phrases.is_empty()).then_some(phrases))
}

fn not_a_list() -> NarsilError {
    NarsilError::new(
        ErrorCode::CONFIG_INVALID,
        "The ban list in the index metadata is not a list of phrases",
    )
}
