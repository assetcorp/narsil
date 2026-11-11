use narsil::{BatchFailure, BatchResult, ErrorCode, Map, NarsilError};
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyMapping, PyString};

use super::PyNarsil;
use crate::convert::fields::{Fields, items_of, strings_of};
use crate::convert::results::batch_result;
use crate::convert::value::{ValueSource, map_to_py, to_map};
use crate::errors::{invalid, to_py_err};

const DOCUMENT: ValueSource<'static> = ValueSource {
    code: ErrorCode::DOC_VALIDATION_FAILED,
    subject: "The document",
};

struct Converted<T> {
    accepted: Vec<T>,
    refused: Vec<BatchFailure>,
}

impl<T> Converted<T> {
    fn with_capacity(capacity: usize) -> Converted<T> {
        Converted {
            accepted: Vec::with_capacity(capacity),
            refused: Vec::new(),
        }
    }

    fn settle(&mut self, item: &Bound<'_, PyAny>, id_key: &str, outcome: Result<T, NarsilError>) {
        match outcome {
            Ok(value) => self.accepted.push(value),
            Err(error) => self.refused.push(BatchFailure {
                doc_id: string_under(item, id_key),
                error,
            }),
        }
    }

    fn merged(self, mut written: BatchResult) -> BatchResult {
        let mut failed = self.refused;
        failed.append(&mut written.failed);
        written.failed = failed;
        written
    }
}

fn string_under(item: &Bound<'_, PyAny>, key: &str) -> String {
    item.cast::<PyMapping>()
        .ok()
        .and_then(|mapping| mapping.get_item(key).ok())
        .and_then(|value| value.extract::<String>().ok())
        .unwrap_or_default()
}

fn documents_of(documents: &Bound<'_, PyAny>) -> Result<Converted<Map>, NarsilError> {
    let items = items_of(documents, "documents")
        .map_err(|error| invalid(ErrorCode::DOC_VALIDATION_FAILED, error.message()))?;
    let mut converted = Converted::with_capacity(items.len());
    for (at, document) in items.iter().enumerate() {
        let subject = format!("documents[{at}]");
        let outcome = to_map(
            document,
            ValueSource {
                code: ErrorCode::DOC_VALIDATION_FAILED,
                subject: &subject,
            },
        );
        converted.settle(document, "id", outcome);
    }
    Ok(converted)
}

fn update_of(update: &Bound<'_, PyAny>, label: &str) -> Result<(String, Map), NarsilError> {
    let mut fields = Fields::of(update, label)?;
    let doc_id = fields.required_string("docId")?;
    let document = fields.get("document")?.ok_or_else(|| {
        invalid(
            ErrorCode::DOC_VALIDATION_FAILED,
            format!("{label}.document is required"),
        )
    })?;
    let subject = format!("{label}.document");
    let document = to_map(
        &document,
        ValueSource {
            code: ErrorCode::DOC_VALIDATION_FAILED,
            subject: &subject,
        },
    )?;
    fields.finish()?;
    Ok((doc_id, document))
}

fn updates_of(updates: &Bound<'_, PyAny>) -> Result<Converted<(String, Map)>, NarsilError> {
    let items = items_of(updates, "updates")?;
    let mut converted = Converted::with_capacity(items.len());
    for (at, update) in items.iter().enumerate() {
        let outcome = update_of(update, &format!("updates[{at}]")).map_err(|error| {
            if error.code() == ErrorCode::CONFIG_INVALID {
                invalid(ErrorCode::DOC_VALIDATION_FAILED, error.message())
            } else {
                error
            }
        });
        converted.settle(update, "docId", outcome);
    }
    Ok(converted)
}

#[pymethods]
impl PyNarsil {
    #[pyo3(signature = (index, document, doc_id = None))]
    fn insert(
        &self,
        py: Python<'_>,
        index: &str,
        document: &Bound<'_, PyAny>,
        doc_id: Option<&str>,
    ) -> PyResult<String> {
        let document = to_map(document, DOCUMENT).map_err(to_py_err)?;
        let engine = self.handle.engine()?;
        py.detach(|| engine.insert(index, document, doc_id))
            .map_err(to_py_err)
    }

    fn insert_batch<'py>(
        &self,
        py: Python<'py>,
        index: &str,
        documents: &Bound<'py, PyAny>,
    ) -> PyResult<Bound<'py, PyDict>> {
        let mut converted = documents_of(documents).map_err(to_py_err)?;
        let documents = std::mem::take(&mut converted.accepted);
        let engine = self.handle.engine()?;
        let result = py
            .detach(|| engine.insert_batch(index, documents))
            .map_err(to_py_err)?;
        batch_result(py, converted.merged(result))
    }

    fn update(
        &self,
        py: Python<'_>,
        index: &str,
        doc_id: &str,
        document: &Bound<'_, PyAny>,
    ) -> PyResult<()> {
        let document = to_map(document, DOCUMENT).map_err(to_py_err)?;
        let engine = self.handle.engine()?;
        py.detach(|| engine.update(index, doc_id, document))
            .map_err(to_py_err)
    }

    fn update_batch<'py>(
        &self,
        py: Python<'py>,
        index: &str,
        updates: &Bound<'py, PyAny>,
    ) -> PyResult<Bound<'py, PyDict>> {
        let mut converted = updates_of(updates).map_err(to_py_err)?;
        let updates = std::mem::take(&mut converted.accepted);
        let engine = self.handle.engine()?;
        let result = py
            .detach(|| engine.update_batch(index, updates))
            .map_err(to_py_err)?;
        batch_result(py, converted.merged(result))
    }

    fn remove(&self, py: Python<'_>, index: &str, doc_id: &str) -> PyResult<()> {
        let engine = self.handle.engine()?;
        py.detach(|| engine.remove(index, doc_id))
            .map_err(to_py_err)
    }

    fn remove_batch<'py>(
        &self,
        py: Python<'py>,
        index: &str,
        doc_ids: &Bound<'py, PyAny>,
    ) -> PyResult<Bound<'py, PyDict>> {
        let doc_ids = ids_of(doc_ids)?;
        let engine = self.handle.engine()?;
        let result = py
            .detach(|| engine.remove_batch(index, doc_ids))
            .map_err(to_py_err)?;
        batch_result(py, result)
    }

    fn get<'py>(
        &self,
        py: Python<'py>,
        index: &str,
        doc_id: &str,
    ) -> PyResult<Option<Bound<'py, PyDict>>> {
        let engine = self.handle.engine()?;
        let found = py.detach(|| engine.get(index, doc_id)).map_err(to_py_err)?;
        found.map(|document| map_to_py(py, &document)).transpose()
    }

    fn get_multiple<'py>(
        &self,
        py: Python<'py>,
        index: &str,
        doc_ids: &Bound<'py, PyAny>,
    ) -> PyResult<Bound<'py, PyDict>> {
        let doc_ids = ids_of(doc_ids)?;
        let engine = self.handle.engine()?;
        let found = py
            .detach(|| engine.get_multiple(index, &doc_ids))
            .map_err(to_py_err)?;
        let dict = PyDict::new(py);
        for (doc_id, document) in &found {
            dict.set_item(doc_id, map_to_py(py, document)?)?;
        }
        Ok(dict)
    }

    fn has(&self, py: Python<'_>, index: &str, doc_id: &str) -> PyResult<bool> {
        let engine = self.handle.engine()?;
        py.detach(|| engine.has(index, doc_id)).map_err(to_py_err)
    }

    fn count_documents(&self, py: Python<'_>, index: &str) -> PyResult<u64> {
        let engine = self.handle.engine()?;
        py.detach(|| engine.count_documents(index))
            .map_err(to_py_err)
    }

    fn clear(&self, py: Python<'_>, index: &str) -> PyResult<()> {
        let engine = self.handle.engine()?;
        py.detach(|| engine.clear(index)).map_err(to_py_err)
    }

    fn wait_for_writes(&self, py: Python<'_>, index: &str) -> PyResult<()> {
        let engine = self.handle.engine()?;
        py.detach(|| engine.wait_for_writes(index))
            .map_err(to_py_err)
    }
}

pub(crate) fn ids_of(doc_ids: &Bound<'_, PyAny>) -> PyResult<Vec<String>> {
    if doc_ids.cast::<PyString>().is_ok() {
        return Err(to_py_err(invalid(
            ErrorCode::CONFIG_INVALID,
            "doc_ids must be a list of IDs, and it is a single string",
        )));
    }
    strings_of(doc_ids, "doc_ids").map_err(to_py_err)
}
