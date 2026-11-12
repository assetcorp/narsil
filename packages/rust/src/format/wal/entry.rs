use crate::error::{ErrorCode, NarsilError, Result};
use crate::util::hash::crc32;
use crate::value::{
    Value, decode_value, write_array_header, write_binary, write_map_header, write_nil,
    write_number, write_string,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Operation {
    Index,
    Delete,
}

impl Operation {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Operation::Index => "INDEX",
            Operation::Delete => "DELETE",
        }
    }
}

/// One record of the write-ahead log, which is also one entry of the replication log.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct LogEntry {
    pub(crate) seq_no: f64,
    pub(crate) primary_term: f64,
    pub(crate) operation: Operation,
    pub(crate) partition_id: f64,
    pub(crate) index_name: String,
    pub(crate) document_id: String,
    pub(crate) document: Option<Vec<u8>>,
    pub(crate) previous_document: Option<Option<Vec<u8>>>,
    pub(crate) checksum: f64,
}

fn write_optional_binary(out: &mut Vec<u8>, bytes: Option<&Vec<u8>>) {
    match bytes {
        Some(bytes) => write_binary(out, bytes),
        None => write_nil(out),
    }
}

fn held_bytes(entry: &LogEntry) -> usize {
    let previous = entry.previous_document.as_ref().and_then(Option::as_ref);
    entry.document.as_ref().map_or(0, Vec::len) + previous.map_or(0, Vec::len)
}

pub(crate) fn entry_checksum(entry: &LogEntry) -> u32 {
    let mut out = Vec::with_capacity(64 + held_bytes(entry));
    let items = if entry.previous_document.is_some() {
        8
    } else {
        7
    };
    write_array_header(&mut out, items);
    write_number(&mut out, entry.seq_no);
    write_number(&mut out, entry.primary_term);
    write_string(&mut out, entry.operation.name());
    write_number(&mut out, entry.partition_id);
    write_string(&mut out, &entry.index_name);
    write_string(&mut out, &entry.document_id);
    write_optional_binary(&mut out, entry.document.as_ref());
    if let Some(previous) = &entry.previous_document {
        write_optional_binary(&mut out, previous.as_ref());
    }
    crc32(&out)
}

/// Where one entry stands in its log: its sequence number, the primary term that wrote it, and its partition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct EntryPlace<'a> {
    pub(crate) seq_no: u64,
    pub(crate) primary_term: u64,
    pub(crate) partition_id: u32,
    pub(crate) index_name: &'a str,
}

impl LogEntry {
    pub(crate) fn new(
        place: EntryPlace<'_>,
        operation: Operation,
        document_id: &str,
        document: Option<Vec<u8>>,
        previous_document: Option<Option<Vec<u8>>>,
    ) -> LogEntry {
        let mut entry = LogEntry {
            seq_no: place.seq_no as f64,
            primary_term: place.primary_term as f64,
            operation,
            partition_id: place.partition_id as f64,
            index_name: place.index_name.to_string(),
            document_id: document_id.to_string(),
            document,
            previous_document,
            checksum: 0.0,
        };
        entry.checksum = entry_checksum(&entry) as f64;
        entry
    }
}

pub(crate) fn encode_entry(entry: &LogEntry) -> Vec<u8> {
    let mut out = Vec::with_capacity(128 + held_bytes(entry));
    let keys = if entry.previous_document.is_some() {
        9
    } else {
        8
    };
    write_map_header(&mut out, keys);
    write_string(&mut out, "seqNo");
    write_number(&mut out, entry.seq_no);
    write_string(&mut out, "primaryTerm");
    write_number(&mut out, entry.primary_term);
    write_string(&mut out, "operation");
    write_string(&mut out, entry.operation.name());
    write_string(&mut out, "partitionId");
    write_number(&mut out, entry.partition_id);
    write_string(&mut out, "indexName");
    write_string(&mut out, &entry.index_name);
    write_string(&mut out, "documentId");
    write_string(&mut out, &entry.document_id);
    write_string(&mut out, "document");
    write_optional_binary(&mut out, entry.document.as_ref());
    if let Some(previous) = &entry.previous_document {
        write_string(&mut out, "previousDocument");
        write_optional_binary(&mut out, previous.as_ref());
    }
    write_string(&mut out, "checksum");
    write_number(&mut out, entry.checksum);
    out
}

fn invalid(message: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_WAL_CORRUPT,
        format!("Invalid EntryPayload: {message}"),
    )
}

fn entry_from_value(value: &Value) -> Result<LogEntry> {
    let Value::Object(map) = value else {
        return Err(invalid("missing or invalid \"entry\" field"));
    };
    let number = |key: &str| match map.get(key) {
        Some(Value::Number(number)) => Ok(*number),
        _ => Err(invalid(&format!("\"entry.{key}\" must be a number"))),
    };
    let text = |key: &str| match map.get(key) {
        Some(Value::String(text)) => Ok(text.clone()),
        _ => Err(invalid(&format!("\"entry.{key}\" must be a string"))),
    };
    let seq_no = number("seqNo")?;
    let primary_term = number("primaryTerm")?;
    let operation = match map.get("operation").and_then(Value::as_str) {
        Some("INDEX") => Operation::Index,
        Some("DELETE") => Operation::Delete,
        _ => {
            return Err(invalid(
                "\"entry.operation\" must be \"INDEX\" or \"DELETE\"",
            ));
        }
    };
    let partition_id = number("partitionId")?;
    let index_name = text("indexName")?;
    let document_id = text("documentId")?;
    let document = match map.get("document") {
        Some(Value::Null) => None,
        Some(Value::Bytes(bytes)) => Some(bytes.clone()),
        _ => return Err(invalid("\"entry.document\" must be Uint8Array or null")),
    };
    let previous_document = match map.get("previousDocument") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::Bytes(bytes)) => Some(Some(bytes.clone())),
        _ => {
            return Err(invalid(
                "\"entry.previousDocument\" must be Uint8Array or null",
            ));
        }
    };
    let checksum = number("checksum")?;
    Ok(LogEntry {
        seq_no,
        primary_term,
        operation,
        partition_id,
        index_name,
        document_id,
        document,
        previous_document,
        checksum,
    })
}

pub(crate) fn decode_entry(payload: &[u8]) -> Result<LogEntry> {
    let entry = entry_from_value(&decode_value(payload)?)?;
    if entry_checksum(&entry) as f64 != entry.checksum {
        return Err(NarsilError::new(
            ErrorCode::PERSISTENCE_WAL_CORRUPT,
            "WAL record failed its logical entry checksum",
        ));
    }
    Ok(entry)
}
