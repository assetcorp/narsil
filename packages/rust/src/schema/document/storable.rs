use std::collections::HashSet;

use super::{MAX_DOCUMENT_NESTING_DEPTH, failed, typeof_of};
use crate::error::{NarsilError, Result};
use crate::value::{Map, Value};

const MAX_NANOSECONDS: u32 = 999_999_999;
const RESERVED_OBJECT_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];

fn reject_storable(path: &str, reason: &str) -> NarsilError {
    let shown = if path.is_empty() { "(document)" } else { path };
    failed(format!("Field \"{shown}\" {reason}"))
}

fn walk_storable(value: &Value, path: &str, depth: usize, skip: &HashSet<String>) -> Result<()> {
    match value {
        Value::Timestamp(timestamp) if timestamp.nanoseconds > MAX_NANOSECONDS => Err(
            reject_storable(path, "holds an invalid date, which the engine cannot store"),
        ),
        Value::Array(items) => {
            if depth >= MAX_DOCUMENT_NESTING_DEPTH {
                return Err(reject_storable(
                    path,
                    &format!("nests deeper than {MAX_DOCUMENT_NESTING_DEPTH} levels"),
                ));
            }
            for (at, item) in items.iter().enumerate() {
                walk_storable(item, &format!("{path}[{at}]"), depth + 1, skip)?;
            }
            Ok(())
        }
        Value::Object(map) => {
            if depth >= MAX_DOCUMENT_NESTING_DEPTH {
                return Err(reject_storable(
                    path,
                    &format!("nests deeper than {MAX_DOCUMENT_NESTING_DEPTH} levels"),
                ));
            }
            walk_entries(map, path, depth, skip)
        }
        _ => Ok(()),
    }
}

pub(super) fn walk_entries(
    map: &Map,
    path: &str,
    depth: usize,
    skip: &HashSet<String>,
) -> Result<()> {
    for (key, entry) in map.iter() {
        let key_path = if path.is_empty() {
            key.clone()
        } else {
            format!("{path}.{key}")
        };
        if RESERVED_OBJECT_KEYS.contains(&key.as_str()) {
            return Err(reject_storable(&key_path, "uses a reserved object key"));
        }
        if skip.contains(&key_path) {
            continue;
        }
        walk_storable(entry, &key_path, depth + 1, skip)?;
    }
    Ok(())
}

pub(super) fn require_id_field(document: &Map) -> Result<()> {
    let Some(id) = document.get("id") else {
        return Ok(());
    };
    let held = match id {
        Value::String(text) if !text.is_empty() => return Ok(()),
        Value::String(_) => "an empty string".to_string(),
        Value::Null => "null".to_string(),
        other => format!("a {}", typeof_of(other)),
    };
    Err(failed(format!(
        "Field \"id\" holds {held}, while the engine stores a document under its id field, so that field must hold a non-empty string"
    )))
}
