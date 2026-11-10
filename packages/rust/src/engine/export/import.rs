use std::collections::{BinaryHeap, HashMap, HashSet};
use std::io::{BufReader, Read};

use crate::config::{IndexConfig, restored_config_fields, restored_embedding};
use crate::engine::Narsil;
use crate::engine::constants::{IMPORT_BATCH_DOCUMENTS, MAX_IMPORT_REFUSALS_REPORTED};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::document_export::{
    ExportLine, ExportLines, MAX_EXPORT_LINE_BYTES, document_of_line, header_configuration,
    header_rejection,
};
use crate::schema::flatten_schema;
use crate::value::{Map, Value};

/// One line of a document export that an import refused, with the reason.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportRefusal {
    /// The number of the line in the export, counted from 1 at the header.
    pub line: usize,
    /// The error code of the refusal.
    pub code: ErrorCode,
    /// Why the import refused the line.
    pub message: String,
}

/// What an import of a document export did.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DocumentImportResult {
    /// The number of documents that the import wrote.
    pub imported: u64,
    /// The number of lines that the import refused.
    pub refused_count: u64,
    /// The refused lines with the lowest line numbers, at most 1,000 of them, in line order.
    pub refused: Vec<ImportRefusal>,
}

struct PendingDocument {
    line: usize,
    doc_id: String,
    document: Map,
}

struct RankedRefusal {
    seq: u64,
    refusal: ImportRefusal,
}

impl RankedRefusal {
    fn rank(&self) -> (usize, u64) {
        (self.refusal.line, self.seq)
    }
}

impl PartialEq for RankedRefusal {
    fn eq(&self, other: &RankedRefusal) -> bool {
        self.rank() == other.rank()
    }
}

impl Eq for RankedRefusal {}

impl PartialOrd for RankedRefusal {
    fn partial_cmp(&self, other: &RankedRefusal) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for RankedRefusal {
    fn cmp(&self, other: &RankedRefusal) -> std::cmp::Ordering {
        self.rank().cmp(&other.rank())
    }
}

struct ImportState<'a> {
    engine: &'a Narsil,
    index: &'a str,
    batch: Vec<PendingDocument>,
    batch_ids: HashSet<String>,
    imported: u64,
    refused_count: u64,
    lowest_refusals: BinaryHeap<RankedRefusal>,
}

fn read_failed(error: std::io::Error) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_LOAD_FAILED,
        format!("The document export could not be read: {error}"),
    )
}

fn config_of_header(line: Option<&ExportLine>) -> Result<IndexConfig> {
    let configuration = header_configuration(line)?;
    let reject = |message: &str| header_rejection(message);
    let mut config = restored_config_fields(&configuration, &reject)?;
    config.embedding = match configuration.get("embedding") {
        None => None,
        Some(raw) => Some(restored_embedding(raw, &reject)?),
    };
    config.schema = configuration.get("schema").cloned().unwrap_or(Value::Null);
    config.language = configuration
        .get("language")
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok(config)
}

fn flat(schema: &Value) -> Map {
    schema.as_object().map(flatten_schema).unwrap_or_default()
}

fn prepare_index(engine: &Narsil, index: &str, config: IndexConfig) -> Result<()> {
    let Ok(existing) = engine.inner.open_index(index) else {
        return engine.create_index(index, config);
    };
    let held = flat(&existing.config().schema);
    let exported = flat(&config.schema);
    for field in held.keys().chain(exported.keys()) {
        if held.get(field) == exported.get(field) {
            continue;
        }
        return Err(NarsilError::new(
            ErrorCode::CONFIG_INVALID,
            format!(
                "Index \"{index}\" gives field \"{field}\" another type than the export does, so the import cannot write into it"
            ),
        ));
    }
    Ok(())
}

impl ImportState<'_> {
    fn refuse(&mut self, line: usize, code: ErrorCode, message: String) {
        self.refused_count += 1;
        self.lowest_refusals.push(RankedRefusal {
            seq: self.refused_count,
            refusal: ImportRefusal {
                line,
                code,
                message,
            },
        });
        if self.lowest_refusals.len() > MAX_IMPORT_REFUSALS_REPORTED {
            self.lowest_refusals.pop();
        }
    }

    fn finish(self) -> DocumentImportResult {
        DocumentImportResult {
            imported: self.imported,
            refused_count: self.refused_count,
            refused: self
                .lowest_refusals
                .into_sorted_vec()
                .into_iter()
                .map(|ranked| ranked.refusal)
                .collect(),
        }
    }

    fn flush(&mut self) -> Result<()> {
        if self.batch.is_empty() {
            return Ok(());
        }
        let batch = std::mem::take(&mut self.batch);
        self.batch_ids.clear();
        let mut line_of = HashMap::with_capacity(batch.len());
        let mut inserts = Vec::new();
        let mut updates = Vec::new();
        for entry in batch {
            line_of.insert(entry.doc_id.clone(), entry.line);
            if self.engine.has(self.index, &entry.doc_id)? {
                updates.push((entry.doc_id, entry.document));
            } else {
                inserts.push(entry.document);
            }
        }
        let mut outcomes = Vec::with_capacity(2);
        if !inserts.is_empty() {
            outcomes.push(self.engine.insert_batch(self.index, inserts)?);
        }
        if !updates.is_empty() {
            outcomes.push(self.engine.update_batch(self.index, updates)?);
        }
        for outcome in outcomes {
            self.imported += outcome.succeeded.len() as u64;
            for failure in outcome.failed {
                let line = line_of.get(&failure.doc_id).copied().unwrap_or(0);
                self.refuse(
                    line,
                    failure.error.code(),
                    failure.error.message().to_string(),
                );
            }
        }
        Ok(())
    }

    fn take_line(&mut self, entry: &ExportLine) -> Result<()> {
        let (doc_id, document) = match document_of_line(entry) {
            Ok(Some(found)) => found,
            Ok(None) => return Ok(()),
            Err(error) => {
                self.refuse(entry.line, error.code(), error.message().to_string());
                return Ok(());
            }
        };
        if self.batch_ids.contains(&doc_id) {
            self.flush()?;
        }
        self.batch_ids.insert(doc_id.clone());
        self.batch.push(PendingDocument {
            line: entry.line,
            doc_id,
            document,
        });
        if self.batch.len() >= IMPORT_BATCH_DOCUMENTS {
            self.flush()?;
        }
        Ok(())
    }
}

/// Reads a document export into `index`, creating the index from the export's header where the engine holds no
/// index of that name.
pub(crate) fn import_document_export(
    engine: &Narsil,
    index: &str,
    data: &mut dyn Read,
) -> Result<DocumentImportResult> {
    let mut lines = ExportLines::new(BufReader::new(data), MAX_EXPORT_LINE_BYTES);
    let header = lines.next().transpose().map_err(read_failed)?;
    prepare_index(engine, index, config_of_header(header.as_ref())?)?;
    let mut state = ImportState {
        engine,
        index,
        batch: Vec::new(),
        batch_ids: HashSet::new(),
        imported: 0,
        refused_count: 0,
        lowest_refusals: BinaryHeap::new(),
    };
    for entry in lines {
        state.take_line(&entry.map_err(read_failed)?)?;
    }
    state.flush()?;
    Ok(state.finish())
}
