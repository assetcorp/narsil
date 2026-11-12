use std::io::{self, BufRead};

use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::index_configuration::require_configuration_shape;
use crate::value::{
    MAX_SAFE_INTEGER, Map, Value, number_to_text, parse_json_raw, untag_value,
    write_exact_json_into, write_json_into,
};

const DOCUMENT_EXPORT_FORMAT: &str = "narsil-export";
const DOCUMENT_EXPORT_VERSION: f64 = 1.0;
pub(crate) const MAX_EXPORT_LINE_BYTES: usize = 117_443_592;
const NEWLINE: u8 = b'\n';

/// Why a line of an export holds no text that a reader can take.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LineRefusal {
    TooLong,
    NotUtf8,
}

/// One line of an export, numbered from 1.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExportLine {
    pub(crate) line: usize,
    pub(crate) text: std::result::Result<String, LineRefusal>,
}

/// Reads an export line by line, holding at most `max_line_bytes` of any one line in memory.
pub(crate) struct ExportLines<R: BufRead> {
    source: R,
    max_line_bytes: usize,
    line: usize,
    finished: bool,
}

impl<R: BufRead> ExportLines<R> {
    pub(crate) fn new(source: R, max_line_bytes: usize) -> ExportLines<R> {
        ExportLines {
            source,
            max_line_bytes,
            line: 0,
            finished: false,
        }
    }

    fn finish_line(&mut self, pending: Vec<u8>, overflowing: bool) -> ExportLine {
        self.line += 1;
        let text = if overflowing {
            Err(LineRefusal::TooLong)
        } else {
            String::from_utf8(pending).map_err(|_| LineRefusal::NotUtf8)
        };
        ExportLine {
            line: self.line,
            text,
        }
    }

    fn next_line(&mut self) -> io::Result<Option<ExportLine>> {
        if self.finished {
            return Ok(None);
        }
        let mut pending = Vec::new();
        let mut overflowing = false;
        loop {
            let chunk = match self.source.fill_buf() {
                Ok(chunk) => chunk,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            };
            if chunk.is_empty() {
                self.finished = true;
                if pending.is_empty() && !overflowing {
                    return Ok(None);
                }
                return Ok(Some(self.finish_line(pending, overflowing)));
            }
            let newline = chunk.iter().position(|&byte| byte == NEWLINE);
            let piece = &chunk[..newline.unwrap_or(chunk.len())];
            if !overflowing && pending.len() + piece.len() <= self.max_line_bytes {
                pending.extend_from_slice(piece);
            } else {
                overflowing = true;
                pending = Vec::new();
            }
            let consumed = newline.map_or(chunk.len(), |at| at + 1);
            self.source.consume(consumed);
            if newline.is_some() {
                return Ok(Some(self.finish_line(pending, overflowing)));
            }
        }
    }
}

impl<R: BufRead> Iterator for ExportLines<R> {
    type Item = io::Result<ExportLine>;

    fn next(&mut self) -> Option<Self::Item> {
        self.next_line().transpose()
    }
}

fn invalid_header(message: impl AsRef<str>) -> NarsilError {
    NarsilError::new(
        ErrorCode::CONFIG_INVALID,
        format!("The document export header {}", message.as_ref()),
    )
}

/// Returns the refusal of a bad setting in the index configuration of an export's header.
pub(crate) fn header_rejection(message: &str) -> NarsilError {
    invalid_header(message)
}

/// Checks the header line of an export and returns the index configuration that it holds.
pub(crate) fn header_configuration(line: Option<&ExportLine>) -> Result<Map> {
    let Some(line) = line else {
        return Err(invalid_header("is missing"));
    };
    let text = match &line.text {
        Ok(text) => text,
        Err(LineRefusal::TooLong) => {
            return Err(invalid_header(format!(
                "passes the line limit of {MAX_EXPORT_LINE_BYTES} bytes"
            )));
        }
        Err(LineRefusal::NotUtf8) => return Err(invalid_header("is not UTF-8")),
    };
    let raw = parse_json_raw(text).map_err(|_| invalid_header("is not JSON"))?;
    let named = raw.as_object().filter(|header| {
        header.get("format").and_then(Value::as_str) == Some(DOCUMENT_EXPORT_FORMAT)
            && header.get("version").and_then(Value::as_f64) == Some(DOCUMENT_EXPORT_VERSION)
    });
    let Some(header) = named else {
        return Err(invalid_header(format!(
            "must name format \"{DOCUMENT_EXPORT_FORMAT}\" and version 1"
        )));
    };
    require_configuration_shape(
        header.get("index").unwrap_or(&Value::Null),
        "document export header",
    )
}

fn refused(message: impl Into<String>) -> NarsilError {
    NarsilError::new(ErrorCode::DOC_VALIDATION_FAILED, message.into())
}

/// Reads one document line, returning `None` for an empty line and the document's ID with the document otherwise.
pub(crate) fn document_of_line(line: &ExportLine) -> Result<Option<(String, Map)>> {
    let text = match &line.text {
        Ok(text) => text,
        Err(LineRefusal::TooLong) => {
            return Err(refused(format!(
                "The line passes the limit of {MAX_EXPORT_LINE_BYTES} bytes"
            )));
        }
        Err(LineRefusal::NotUtf8) => return Err(refused("The line is not UTF-8")),
    };
    if text.is_empty() {
        return Ok(None);
    }
    let raw = parse_json_raw(text).map_err(|_| refused("The line is not JSON"))?;
    let id = match &raw {
        Value::Object(document) => match document.get("id") {
            Some(Value::String(id)) if !id.is_empty() => id.clone(),
            _ => return Err(refused("The line holds no document with a string id")),
        },
        _ => return Err(refused("The line holds no document with a string id")),
    };
    let holds_tags = text.contains("\"$") || text.contains("\\u0024");
    let document = if holds_tags {
        untag_value(raw, "", 0)?
    } else {
        raw
    };
    match document {
        Value::Object(document) => Ok(Some((id, document))),
        _ => Err(refused("The line holds no document with a string id")),
    }
}

fn require_json_values(value: &Value, path: &str, doc_id: &str, tagged: bool) -> Result<()> {
    let place = if path.is_empty() { "(document)" } else { path };
    let refuse = |kind: &str| {
        Err(NarsilError::new(
            ErrorCode::DOC_VALIDATION_FAILED,
            format!(
                "Document \"{doc_id}\" holds {kind} at \"{place}\", which a document export cannot carry as JSON"
            ),
        ))
    };
    match value {
        Value::Number(number) if !number.is_finite() && !tagged => refuse(&number_to_text(*number)),
        Value::Bytes(_) if !tagged => refuse("bytes"),
        Value::Timestamp(_) if !tagged => refuse("a date"),
        Value::Timestamp(timestamp) if timestamp.seconds.unsigned_abs() > MAX_SAFE_INTEGER => {
            refuse("a date")
        }
        Value::Array(items) => items.iter().enumerate().try_for_each(|(at, item)| {
            require_json_values(item, &format!("{path}[{at}]"), doc_id, tagged)
        }),
        Value::Object(map) => map.iter().try_for_each(|(key, entry)| {
            let child = if path.is_empty() {
                key.clone()
            } else {
                format!("{path}.{key}")
            };
            require_json_values(entry, &child, doc_id, tagged)
        }),
        _ => Ok(()),
    }
}

/// The change capture epoch of an index and the checkpoint's last sequence number in each partition, in partition
/// order, which the header of an export of an index with capture on holds.
pub(crate) struct ExportPositions {
    pub(crate) epoch: String,
    pub(crate) positions: Vec<(u32, u64)>,
}

fn positions_value(positions: &[(u32, u64)]) -> Value {
    Value::Array(
        positions
            .iter()
            .map(|(partition_id, seq_no)| {
                let mut position = Map::with_capacity(2);
                position.insert("partitionId", Value::Number(f64::from(*partition_id)));
                position.insert("seqNo", Value::Number(*seq_no as f64));
                Value::Object(position)
            })
            .collect(),
    )
}

/// Writes the header line of an export, ended by a line feed, with the epoch and the positions after the index
/// configuration where the index has change capture on.
pub(crate) fn header_line(
    configuration: &Map,
    capture: Option<&ExportPositions>,
) -> Result<String> {
    let mut header = Map::with_capacity(5);
    header.insert("format", Value::String(DOCUMENT_EXPORT_FORMAT.to_string()));
    header.insert("version", Value::Number(DOCUMENT_EXPORT_VERSION));
    header.insert("index", Value::Object(configuration.clone()));
    if let Some(capture) = capture {
        header.insert("epoch", Value::String(capture.epoch.clone()));
        header.insert("positions", positions_value(&capture.positions));
    }
    let header = Value::Object(header);
    require_json_values(&header, "", "", false)?;
    let mut line = String::new();
    write_exact_json_into(&mut line, &header);
    line.push('\n');
    Ok(line)
}

/// Writes one document line, with the document's ID first and a tag for each value that JSON has no type for.
pub(crate) fn document_line(doc_id: &str, document: &Map) -> Result<String> {
    let mut held = Map::with_capacity(document.len() + 1);
    held.insert("id", Value::String(doc_id.to_string()));
    for (key, value) in document.iter() {
        held.insert(key.clone(), value.clone());
    }
    held.insert("id", Value::String(doc_id.to_string()));
    let held = Value::Object(held);
    require_json_values(&held, "", doc_id, true)?;
    let mut line = String::new();
    write_json_into(&mut line, &held);
    line.push('\n');
    Ok(line)
}
