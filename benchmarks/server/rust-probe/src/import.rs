use std::collections::HashSet;

use axum::http::StatusCode;
use narsil::{Map, Narsil, Value};
use serde::Serialize;

use crate::constants::{IMPORT_BATCH_SIZE, MAX_IMPORT_ERRORS, MAX_LINE_BYTES};
use crate::errors::ApiError;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportFailure {
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    doc_id: Option<String>,
    code: String,
    message: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    indexed: u64,
    failed: u64,
    errors: Vec<ImportFailure>,
    errors_truncated: bool,
}

impl ImportOutcome {
    fn record(&mut self, failure: ImportFailure) {
        self.failed += 1;
        if self.errors.len() < MAX_IMPORT_ERRORS {
            self.errors.push(failure);
        }
    }

    fn line_failure(&mut self, line: u64, code: &str, message: &str) {
        self.record(ImportFailure {
            line: Some(line),
            doc_id: None,
            code: code.to_owned(),
            message: message.to_owned(),
        });
    }
}

fn provided_id(document: &Map) -> Option<&str> {
    match document.get("id") {
        Some(Value::String(id)) if !id.is_empty() => Some(id),
        _ => None,
    }
}

fn flush(
    engine: &Narsil,
    index: &str,
    documents: Vec<Map>,
    outcome: &mut ImportOutcome,
) -> Result<(), ApiError> {
    if documents.is_empty() {
        return Ok(());
    }
    let result = engine.insert_batch(index, documents)?;
    outcome.indexed += u64::try_from(result.succeeded.len()).unwrap_or(u64::MAX);
    for failure in result.failed {
        outcome.record(ImportFailure {
            line: None,
            doc_id: Some(failure.doc_id),
            code: failure.error.code().as_str().to_owned(),
            message: failure.error.message().to_owned(),
        });
    }
    Ok(())
}

fn trimmed_line(raw: &[u8]) -> &[u8] {
    match raw.last() {
        Some(b'\r') => &raw[..raw.len() - 1],
        _ => raw,
    }
}

fn parse_line(bytes: &[u8]) -> Result<Map, (&'static str, &'static str)> {
    let text =
        std::str::from_utf8(bytes).map_err(|_| ("INVALID_JSON", "Line is not valid JSON"))?;
    match narsil::parse_json(text) {
        Ok(Value::Object(document)) => Ok(document),
        Ok(_) => Err(("INVALID_REQUEST", "Line is not a JSON object")),
        Err(_) => Err(("INVALID_JSON", "Line is not valid JSON")),
    }
}

pub fn run_import(engine: &Narsil, index: &str, body: &[u8]) -> Result<ImportOutcome, ApiError> {
    if body.is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "EMPTY_BODY",
            "Request body is empty",
        ));
    }
    let mut outcome = ImportOutcome::default();
    let mut pending: Vec<Map> = Vec::with_capacity(IMPORT_BATCH_SIZE);
    let mut repeated: Vec<Map> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut line_number: u64 = 0;
    for raw in body.split(|byte| *byte == b'\n') {
        if raw.len() > MAX_LINE_BYTES {
            return Err(ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "PAYLOAD_TOO_LARGE",
                format!(
                    "NDJSON line {} exceeds the configured per-line size limit",
                    line_number + 1
                ),
            ));
        }
        let line = trimmed_line(raw);
        if line.is_empty() {
            continue;
        }
        line_number += 1;
        let document = match parse_line(line) {
            Ok(document) => document,
            Err((code, message)) => {
                outcome.line_failure(line_number, code, message);
                continue;
            }
        };
        if let Some(id) = provided_id(&document) {
            if seen.contains(id) {
                repeated.push(document);
                continue;
            }
            seen.insert(id.to_owned());
        }
        pending.push(document);
        if pending.len() >= IMPORT_BATCH_SIZE {
            let batch = std::mem::replace(&mut pending, Vec::with_capacity(IMPORT_BATCH_SIZE));
            flush(engine, index, batch, &mut outcome)?;
        }
    }
    flush(engine, index, pending, &mut outcome)?;
    for _ in 0..repeated.len().div_ceil(IMPORT_BATCH_SIZE) {
        let rest = repeated.split_off(repeated.len().min(IMPORT_BATCH_SIZE));
        let batch = std::mem::replace(&mut repeated, rest);
        flush(engine, index, batch, &mut outcome)?;
    }
    outcome.errors_truncated =
        outcome.failed > u64::try_from(outcome.errors.len()).unwrap_or(u64::MAX);
    Ok(outcome)
}
