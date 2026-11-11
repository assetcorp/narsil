use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::wal::{LogEntry, Operation};
use crate::value::{Map, decode_document};

use super::types::{Change, ChangeType};

pub(super) fn change_of(entry: LogEntry) -> Result<Change> {
    let seq_no = entry.seq_no as u64;
    let previous = match &entry.previous_document {
        Some(Some(bytes)) => Some(decode_document(bytes)?),
        _ => None,
    };
    let (change_type, document) = match entry.operation {
        Operation::Index => {
            let Some(bytes) = &entry.document else {
                return Err(NarsilError::new(
                    ErrorCode::PERSISTENCE_WAL_CORRUPT,
                    format!(
                        "The log entry {seq_no} of index \"{}\" stores document \"{}\" without its body",
                        entry.index_name, entry.document_id
                    ),
                ));
            };
            let change_type = match &entry.previous_document {
                None => ChangeType::Put,
                Some(None) => ChangeType::Insert,
                Some(Some(_)) => ChangeType::Update,
            };
            (change_type, Some(decode_document(bytes)?))
        }
        Operation::Delete => (ChangeType::Remove, None),
    };
    Ok(Change {
        seq_no,
        change_type,
        document_id: entry.document_id,
        document,
        previous_document: previous,
    })
}

pub(super) fn filtered_change(
    change: Change,
    holds_previous: bool,
    matches: &dyn Fn(&Map) -> Result<bool>,
) -> Result<Option<Change>> {
    let after = match &change.document {
        Some(document) => matches(document)?,
        None => false,
    };
    if !holds_previous {
        if after {
            return Ok(Some(change));
        }
        return Ok(Some(Change {
            change_type: ChangeType::Remove,
            document: None,
            previous_document: None,
            ..change
        }));
    }
    let before = match &change.previous_document {
        Some(document) => matches(document)?,
        None => false,
    };
    Ok(match (before, after) {
        (false, false) => None,
        (true, true) => Some(change),
        (false, true) => Some(Change {
            change_type: ChangeType::Insert,
            previous_document: None,
            ..change
        }),
        (true, false) => Some(Change {
            change_type: ChangeType::Remove,
            document: None,
            ..change
        }),
    })
}
