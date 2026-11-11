use std::path::{Path, PathBuf};
use std::sync::Arc;

use narsil::{
    AdapterError, ErrorCode, FilesystemPersistence, MemoryPersistence, NarsilError,
    PersistenceAdapter,
};
use pyo3::prelude::*;
use pyo3::types::{PyByteArray, PyBytes};

use super::retained::Retained;
use super::{CallbackFailure, call_python};
use crate::convert::fields::strings_of;
use crate::errors::{config_invalid, to_py_err};

const METHODS: [&str; 4] = ["save", "load", "delete", "list"];

/// This store keeps snapshot checkpoints in memory, so that a test or a short-lived process can pass it as the
/// `persistence` setting.
#[pyclass(frozen, module = "narsil._native", name = "MemoryPersistence")]
pub(crate) struct PyMemoryPersistence {
    pub(crate) adapter: Arc<dyn PersistenceAdapter>,
}

#[pymethods]
impl PyMemoryPersistence {
    #[new]
    fn new() -> PyMemoryPersistence {
        PyMemoryPersistence {
            adapter: Arc::new(MemoryPersistence::new()),
        }
    }
}

/// This store keeps an engine's files under one directory, and the `persistence` setting accepts it.
#[pyclass(frozen, module = "narsil._native", name = "FilesystemPersistence")]
pub(crate) struct PyFilesystemPersistence {
    pub(crate) adapter: Arc<dyn PersistenceAdapter>,
}

#[pymethods]
impl PyFilesystemPersistence {
    #[new]
    fn new(py: Python<'_>, directory: PathBuf) -> PyResult<PyFilesystemPersistence> {
        let adapter = py
            .detach(|| FilesystemPersistence::new(&directory))
            .map_err(to_py_err)?;
        Ok(PyFilesystemPersistence {
            adapter: Arc::new(adapter),
        })
    }
}

struct PythonPersistence {
    object: Retained,
    directory: Option<PathBuf>,
}

fn boxed(error: NarsilError) -> AdapterError {
    Box::new(error)
}

impl PythonPersistence {
    fn call<T>(
        &self,
        code: ErrorCode,
        method: &str,
        read: impl for<'py> FnOnce(Python<'py>, Bound<'py, PyAny>) -> Result<T, CallbackFailure>,
        arguments: impl for<'py> FnOnce(Python<'py>) -> PyResult<Bound<'py, pyo3::types::PyTuple>>,
    ) -> Result<T, AdapterError> {
        let subject = format!("The {method} method of the persistence adapter");
        call_python(code, &subject, self.object.awaited_by_engine(), |py| {
            let arguments = arguments(py)?;
            let returned = self.object.bind(py)?.call_method1(method, arguments)?;
            read(py, returned)
        })
        .map_err(boxed)
    }
}

impl PersistenceAdapter for PythonPersistence {
    fn save(&self, key: &str, data: &[u8]) -> Result<(), AdapterError> {
        self.call(
            ErrorCode::PERSISTENCE_SAVE_FAILED,
            "save",
            |_, _| Ok(()),
            |py| {
                pyo3::types::PyTuple::new(
                    py,
                    [
                        key.into_pyobject(py)?.into_any(),
                        PyBytes::new(py, data).into_any(),
                    ],
                )
            },
        )
    }

    fn load(&self, key: &str) -> Result<Option<Vec<u8>>, AdapterError> {
        self.call(
            ErrorCode::PERSISTENCE_LOAD_FAILED,
            "load",
            |_, returned| {
                if returned.is_none() {
                    return Ok(None);
                }
                if let Ok(bytes) = returned.cast::<PyBytes>() {
                    return Ok(Some(bytes.as_bytes().to_vec()));
                }
                if let Ok(bytes) = returned.cast::<PyByteArray>() {
                    return Ok(Some(bytes.to_vec()));
                }
                Err(CallbackFailure::Refused(config_invalid(
                    "load must return bytes or None",
                )))
            },
            |py| pyo3::types::PyTuple::new(py, [key]),
        )
    }

    fn delete(&self, key: &str) -> Result<(), AdapterError> {
        self.call(
            ErrorCode::PERSISTENCE_DELETE_FAILED,
            "delete",
            |_, _| Ok(()),
            |py| pyo3::types::PyTuple::new(py, [key]),
        )
    }

    fn list(&self, prefix: &str) -> Result<Vec<String>, AdapterError> {
        self.call(
            ErrorCode::PERSISTENCE_LOAD_FAILED,
            "list",
            |_, returned| Ok(strings_of(&returned, "the keys that list returned")?),
            |py| pyo3::types::PyTuple::new(py, [prefix]),
        )
    }

    fn directory(&self) -> Option<&Path> {
        self.directory.as_deref()
    }
}

pub(crate) fn persistence_adapter(
    value: &Bound<'_, PyAny>,
    label: &str,
) -> Result<Arc<dyn PersistenceAdapter>, NarsilError> {
    if let Ok(memory) = value.cast::<PyMemoryPersistence>() {
        return Ok(Arc::clone(&memory.get().adapter));
    }
    if let Ok(files) = value.cast::<PyFilesystemPersistence>() {
        return Ok(Arc::clone(&files.get().adapter));
    }
    for method in METHODS {
        let callable = value
            .getattr(method)
            .map(|found| found.is_callable())
            .unwrap_or(false);
        if !callable {
            return Err(config_invalid(format!(
                "{label} must be MemoryPersistence, FilesystemPersistence, or an object with save, load, delete, and list methods, and it has no {method} method"
            )));
        }
    }
    let directory = match value.getattr("directory") {
        Ok(directory) if !directory.is_none() => Some(
            directory
                .extract::<PathBuf>()
                .map_err(|_| config_invalid(format!("{label}.directory must be a path")))?,
        ),
        _ => None,
    };
    Ok(Arc::new(PythonPersistence {
        object: Retained::new(value),
        directory,
    }))
}
