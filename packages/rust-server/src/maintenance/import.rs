use std::collections::HashSet;

use narsil::{BatchResult, Map, Narsil, Value, parse_plain_json};

use super::ndjson::{NdjsonLine, NdjsonLines};
use crate::errors::{ServerError, server_codes};
use crate::state::ResolvedLimits;
use crate::tasks::TaskFailure;

pub(crate) struct ImportSettings {
    max_line_bytes: u64,
    batch_size: usize,
    max_errors: u64,
}

impl ImportSettings {
    pub(crate) fn of(limits: &ResolvedLimits) -> ImportSettings {
        ImportSettings {
            max_line_bytes: limits.max_line_bytes,
            batch_size: usize::try_from(limits.import_batch_size)
                .unwrap_or(usize::MAX)
                .max(1),
            max_errors: limits.max_import_errors,
        }
    }
}

pub(crate) struct ImportRun<'a> {
    pub(crate) engine: &'a Narsil,
    pub(crate) index: &'a str,
    pub(crate) body: &'a [u8],
    pub(crate) settings: &'a ImportSettings,
    pub(crate) cancelled: &'a dyn Fn() -> bool,
    pub(crate) on_progress: &'a dyn Fn(Map),
}

struct Tally {
    indexed: u64,
    failed: u64,
    errors: Vec<Value>,
    bytes_processed: usize,
    max_errors: u64,
}

pub(crate) fn progress_of(indexed: u64, failed: u64, processed: usize, total: usize) -> Map {
    let mut progress = Map::new();
    progress.insert("indexed", Value::Number(indexed as f64));
    progress.insert("failed", Value::Number(failed as f64));
    progress.insert("bytesProcessed", Value::Number(processed as f64));
    progress.insert("bytesTotal", Value::Number(total as f64));
    progress
}

pub(crate) fn import_result(indexed: u64, failed: u64, errors: Vec<Value>) -> Map {
    let truncated = failed > errors.len() as u64;
    let mut result = Map::new();
    result.insert("indexed", Value::Number(indexed as f64));
    result.insert("failed", Value::Number(failed as f64));
    result.insert("errors", Value::Array(errors));
    result.insert("errorsTruncated", Value::Bool(truncated));
    result
}

fn line_error(line: u64, code: &str, message: &str) -> Map {
    let mut error = Map::new();
    error.insert("line", Value::Number(line as f64));
    error.insert("code", Value::String(code.to_string()));
    error.insert("message", Value::String(message.to_string()));
    error
}

impl Tally {
    fn record(&mut self, error: Map) {
        self.failed = self.failed.saturating_add(1);
        if (self.errors.len() as u64) < self.max_errors {
            self.errors.push(Value::Object(error));
        }
    }

    fn count(&mut self, result: BatchResult) {
        self.indexed = self.indexed.saturating_add(result.succeeded.len() as u64);
        for failure in result.failed {
            let mut error = Map::new();
            error.insert("docId", Value::String(failure.doc_id));
            error.insert(
                "code",
                Value::String(failure.error.code().as_str().to_string()),
            );
            error.insert(
                "message",
                Value::String(failure.error.message().to_string()),
            );
            self.record(error);
        }
    }
}

fn document_of(text: &[u8]) -> Result<Map, (&'static str, &'static str)> {
    match parse_plain_json(&String::from_utf8_lossy(text)) {
        Ok(Value::Object(document)) => Ok(document),
        Ok(_) => Err((server_codes::INVALID_REQUEST, "Line is not a JSON object")),
        Err(_) => Err((server_codes::INVALID_JSON, "Line is not valid JSON")),
    }
}

fn provided_id(document: &Map) -> Option<&str> {
    match document.get("id") {
        Some(Value::String(id)) if !id.is_empty() => Some(id),
        _ => None,
    }
}

struct Importer<'a> {
    run: &'a ImportRun<'a>,
    tally: Tally,
}

impl Importer<'_> {
    fn report(&self) {
        (self.run.on_progress)(progress_of(
            self.tally.indexed,
            self.tally.failed,
            self.tally.bytes_processed,
            self.run.body.len(),
        ));
    }

    fn stop_if_cancelled(&self) -> Result<(), TaskFailure> {
        if (self.run.cancelled)() {
            return Err(TaskFailure::Unexpected);
        }
        Ok(())
    }

    fn flush(&mut self, documents: Vec<Map>) -> Result<(), TaskFailure> {
        if documents.is_empty() {
            return Ok(());
        }
        let result = self
            .run
            .engine
            .insert_batch(self.run.index, documents)
            .map_err(|failure| TaskFailure::Coded(ServerError::from(failure)))?;
        self.tally.count(result);
        Ok(())
    }

    fn read(&mut self, repeated: &mut Vec<NdjsonLine>) -> Result<(), TaskFailure> {
        let run = self.run;
        let mut seen: HashSet<String> = HashSet::new();
        let mut pending: Vec<Map> = Vec::new();
        for line in NdjsonLines::new(run.body, run.settings.max_line_bytes) {
            let line = line.map_err(TaskFailure::Coded)?;
            self.tally.bytes_processed = line.consumed;
            let text = run.body.get(line.start..line.end).unwrap_or_default();
            let document = match document_of(text) {
                Ok(document) => document,
                Err((code, message)) => {
                    self.tally.record(line_error(line.number, code, message));
                    continue;
                }
            };
            if let Some(id) = provided_id(&document) {
                if seen.contains(id) {
                    repeated.push(line);
                    continue;
                }
                seen.insert(id.to_string());
            }
            pending.push(document);
            if pending.len() >= run.settings.batch_size {
                self.stop_if_cancelled()?;
                self.flush(std::mem::take(&mut pending))?;
                self.report();
                self.stop_if_cancelled()?;
            }
        }
        self.flush(pending)
    }

    fn import(&mut self) -> Result<(), TaskFailure> {
        let mut repeated = Vec::new();
        self.read(&mut repeated)?;
        for batch in repeated.chunks(self.run.settings.batch_size) {
            self.stop_if_cancelled()?;
            let documents = batch
                .iter()
                .filter_map(|line| self.run.body.get(line.start..line.end))
                .filter_map(|text| document_of(text).ok())
                .collect();
            self.flush(documents)?;
        }
        Ok(())
    }
}

pub(crate) fn run_import(run: &ImportRun<'_>) -> Result<Map, TaskFailure> {
    let mut importer = Importer {
        run,
        tally: Tally {
            indexed: 0,
            failed: 0,
            errors: Vec::new(),
            bytes_processed: 0,
            max_errors: run.settings.max_errors,
        },
    };
    if let Err(failure) = importer.import() {
        importer.report();
        return Err(failure);
    }
    importer.tally.bytes_processed = run.body.len();
    importer.report();
    let tally = importer.tally;
    Ok(import_result(tally.indexed, tally.failed, tally.errors))
}
