use crate::conformance::forms::{form_error, list, object};
use crate::error::Result;
use crate::format::wal::{
    COMMIT_MARKER_FILE_BYTES, COMMIT_MARKER_SLOT_BYTES, CommitMarker, LogEntry, Operation,
    WAL_FORMAT_VERSION, decode_marker_slot, encode_marker_slot, entry_checksum, frame_record,
    read_durable_region, segment_header,
};
use crate::value::{Map, Value, decode_value, encode_value};

const MARKER_FIELDS: [&str; 4] = [
    "writeSeq",
    "activeSegmentSeqNo",
    "durableByteLength",
    "highestDurableSeqNo",
];

fn record_form(entry: &LogEntry) -> Result<Value> {
    let mut map = Map::new();
    map.insert("seqNo", Value::Number(entry.seq_no));
    map.insert("primaryTerm", Value::Number(entry.primary_term));
    map.insert(
        "operation",
        Value::String(entry.operation.name().to_string()),
    );
    map.insert("partitionId", Value::Number(entry.partition_id));
    map.insert("indexName", Value::String(entry.index_name.clone()));
    map.insert("documentId", Value::String(entry.document_id.clone()));
    if let Some(document) = &entry.document {
        map.insert("document", decode_value(document)?);
    }
    if let Some(previous) = &entry.previous_document {
        let value = match previous {
            Some(previous) => decode_value(previous)?,
            None => Value::Null,
        };
        map.insert("previousDocument", value);
    }
    Ok(Value::Object(map))
}

fn previous_document_of(map: &Map) -> Result<Option<Option<Vec<u8>>>> {
    match map.get("previousDocument") {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(previous) => Ok(Some(Some(encode_value(previous)?))),
    }
}

pub(crate) fn read_log_segment(bytes: &[u8]) -> Result<Value> {
    let entries = read_durable_region(bytes, bytes.len())?;
    let records = entries
        .iter()
        .map(record_form)
        .collect::<Result<Vec<_>>>()?;
    let mut form = Map::new();
    form.insert("walFormatVersion", Value::Number(bytes[4] as f64));
    form.insert("records", Value::Array(records));
    Ok(Value::Object(form))
}

fn number(map: &Map, key: &str) -> Result<f64> {
    map.get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| form_error(format!("record.{key} is not a number")))
}

fn text(map: &Map, key: &str) -> Result<String> {
    map.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| form_error(format!("record.{key} is not a string")))
}

pub(crate) fn write_log_segment(form: &Map) -> Result<Vec<u8>> {
    let version = form
        .get("walFormatVersion")
        .and_then(Value::as_f64)
        .map_or(WAL_FORMAT_VERSION, |version| version as u8);
    let mut out = segment_header(version).to_vec();
    for record in list(form.get("records"), "records")? {
        let map = object(Some(record), "record")?;
        let operation = match map.get("operation").and_then(Value::as_str) {
            Some("INDEX") => Operation::Index,
            Some("DELETE") => Operation::Delete,
            _ => return Err(form_error("record.operation is not INDEX or DELETE")),
        };
        let document = map.get("document").map(encode_value).transpose()?;
        let mut entry = LogEntry {
            seq_no: number(map, "seqNo")?,
            primary_term: number(map, "primaryTerm")?,
            operation,
            partition_id: number(map, "partitionId")?,
            index_name: text(map, "indexName")?,
            document_id: text(map, "documentId")?,
            document,
            previous_document: previous_document_of(map)?,
            checksum: 0.0,
        };
        entry.checksum = entry_checksum(&entry) as f64;
        frame_record(&entry, &mut out)?;
    }
    Ok(out)
}

pub(crate) fn read_commit_marker_form(bytes: &[u8]) -> Result<Value> {
    if bytes.len() != COMMIT_MARKER_FILE_BYTES {
        return Err(form_error(format!(
            "a commit marker holds {COMMIT_MARKER_FILE_BYTES} bytes"
        )));
    }
    let slots = (0..2)
        .map(|slot| match decode_marker_slot(bytes, slot) {
            None => Value::Null,
            Some(state) => {
                let mut map = Map::new();
                let values = [
                    state.write_seq,
                    state.active_segment_seq_no,
                    state.durable_byte_length,
                    state.highest_durable_seq_no,
                ];
                for (field, value) in MARKER_FIELDS.iter().zip(values) {
                    map.insert(*field, Value::Number(value as f64));
                }
                Value::Object(map)
            }
        })
        .collect();
    let mut form = Map::new();
    form.insert("slots", Value::Array(slots));
    Ok(Value::Object(form))
}

pub(crate) fn write_commit_marker_form(form: &Map) -> Result<Vec<u8>> {
    let mut out = vec![0u8; COMMIT_MARKER_FILE_BYTES];
    for (at, slot) in list(form.get("slots"), "slots")?.iter().enumerate().take(2) {
        let base = at * COMMIT_MARKER_SLOT_BYTES;
        let Value::Object(map) = slot else { continue };
        let field = |key: &str| {
            map.get(key)
                .and_then(Value::as_f64)
                .map(|value| value as u64)
                .unwrap_or(0)
        };
        let state = CommitMarker {
            write_seq: field("writeSeq"),
            active_segment_seq_no: field("activeSegmentSeqNo"),
            durable_byte_length: field("durableByteLength"),
            highest_durable_seq_no: field("highestDurableSeqNo"),
        };
        out[base..base + COMMIT_MARKER_SLOT_BYTES].copy_from_slice(&encode_marker_slot(&state));
    }
    Ok(out)
}
