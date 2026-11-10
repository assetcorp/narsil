pub(crate) mod bundle;
pub(crate) mod documents;
mod graph;
pub(crate) mod index_snapshot;
pub(crate) mod vector_parts;

use crate::value::{Value, number_to_text};

pub(crate) use bundle::decode_snapshot_bundle;
pub(crate) use documents::{V2Documents, decode_v2_documents};
pub(crate) use index_snapshot::{decode_index_snapshot, open_index_snapshot};
pub(crate) use vector_parts::{EarlierVectorField, EarlierVectorPart};

fn shown_as_text(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(Value::Null) => "null".to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number_to_text(*number),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Object(_)) => "[object Object]".to_string(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => shown_as_text(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Bytes(bytes)) => bytes
            .iter()
            .map(u8::to_string)
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Timestamp(timestamp)) => timestamp.seconds.to_string(),
    }
}
