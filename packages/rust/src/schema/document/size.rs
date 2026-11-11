use super::{MAX_DOCUMENT_BYTES, MAX_DOCUMENT_NESTING_DEPTH, failed};
use crate::error::Result;
use crate::value::{Map, Value, encode_document};

const LARGEST_HEADER_BYTES: usize = 5;
const LARGEST_NUMBER_BYTES: usize = 9;
const LARGEST_TIMESTAMP_BYTES: usize = 15;
const LARGEST_UTF8_BYTES_PER_UNIT: usize = 3;

fn upper_bound_bytes(value: &Value, budget: usize, depth: usize) -> usize {
    match value {
        Value::Null | Value::Bool(_) => 1,
        Value::Number(_) => LARGEST_NUMBER_BYTES,
        Value::String(text) => {
            LARGEST_HEADER_BYTES + text.encode_utf16().count() * LARGEST_UTF8_BYTES_PER_UNIT
        }
        Value::Timestamp(_) => LARGEST_TIMESTAMP_BYTES,
        Value::Bytes(bytes) => LARGEST_HEADER_BYTES + bytes.len(),
        _ if depth > MAX_DOCUMENT_NESTING_DEPTH => LARGEST_NUMBER_BYTES,
        Value::Array(items) => {
            let mut total = LARGEST_HEADER_BYTES;
            for item in items {
                total += upper_bound_bytes(item, budget.saturating_sub(total), depth + 1);
                if total > budget {
                    return total;
                }
            }
            total
        }
        Value::Object(map) => {
            let mut total = LARGEST_HEADER_BYTES;
            for (key, entry) in map.iter() {
                total +=
                    LARGEST_HEADER_BYTES + key.encode_utf16().count() * LARGEST_UTF8_BYTES_PER_UNIT;
                total += upper_bound_bytes(entry, budget.saturating_sub(total), depth + 1);
                if total > budget {
                    return total;
                }
            }
            total
        }
    }
}

/// Raises `DOC_VALIDATION_FAILED` for a document that takes more than 16 MiB as MessagePack.
pub(crate) fn require_document_within_size_limit(document: &Map) -> Result<()> {
    let mut total = LARGEST_HEADER_BYTES;
    for (key, entry) in document.iter() {
        total += LARGEST_HEADER_BYTES + key.encode_utf16().count() * LARGEST_UTF8_BYTES_PER_UNIT;
        total += upper_bound_bytes(entry, MAX_DOCUMENT_BYTES.saturating_sub(total), 1);
        if total > MAX_DOCUMENT_BYTES {
            break;
        }
    }
    if total <= MAX_DOCUMENT_BYTES {
        return Ok(());
    }
    let Ok(encoded) = encode_document(document) else {
        return Ok(());
    };
    if encoded.len() <= MAX_DOCUMENT_BYTES {
        return Ok(());
    }
    Err(failed(format!(
        "The document takes {} bytes as MessagePack, vector values included, but a document may take at most {MAX_DOCUMENT_BYTES}",
        encoded.len()
    )))
}
