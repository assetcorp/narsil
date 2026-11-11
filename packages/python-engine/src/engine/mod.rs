mod documents;
mod events;
mod maintenance;
mod portability;
mod search;
mod suggestions;

use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};

use narsil::{ErrorCode, ListenerId, Narsil, NarsilError};
use pyo3::gc::{PyTraverseError, PyVisit};
use pyo3::prelude::*;
use pyo3::types::PyList;

pub(crate) use suggestions::PyQuerySuggestions;

use crate::callbacks::functions::event_listener;
use crate::callbacks::retained::RetainedSet;
use crate::convert::engine_config::{EngineSetup, engine_setup};
use crate::convert::index_config::index_config;
use crate::convert::results::index_info;
use crate::errors::to_py_err;

pub(crate) struct EngineHandle {
    engine: Option<Narsil>,
}

impl EngineHandle {
    pub(crate) fn engine(&self) -> PyResult<&Narsil> {
        self.engine.as_ref().ok_or_else(|| {
            to_py_err(NarsilError::new(
                ErrorCode::INSTANCE_SHUT_DOWN,
                "The engine has shut down",
            ))
        })
    }
}

impl Drop for EngineHandle {
    fn drop(&mut self) {
        if let Some(engine) = self.engine.take() {
            Python::attach(|py| py.detach(move || drop(engine)));
        }
    }
}

/// This engine holds Narsil indexes inside this Python process.
#[pyclass(frozen, subclass, weakref, module = "narsil._native", name = "Narsil")]
pub(crate) struct PyNarsil {
    pub(crate) handle: Arc<EngineHandle>,
    pub(crate) listeners: Mutex<HashMap<u64, ListenerId>>,
    pub(crate) next_listener: AtomicU64,
    pub(crate) retained: RetainedSet,
}

fn open_engine(setup: EngineSetup) -> Result<Narsil, NarsilError> {
    let EngineSetup {
        config,
        tokenizers,
        stop_words,
        embedding_adapters,
        rerank_adapters,
        plugins,
        listeners,
    } = setup;
    Narsil::open_with(config, move |engine| {
        for (name, tokenizer) in tokenizers {
            engine.register_tokenizer(&name, tokenizer)?;
        }
        for (name, words) in stop_words {
            engine.register_stop_words(&name, words)?;
        }
        for (name, adapter) in embedding_adapters {
            engine.register_embedding_adapter(&name, adapter)?;
        }
        for (name, adapter) in rerank_adapters {
            engine.register_rerank_adapter(&name, adapter)?;
        }
        for plugin in plugins {
            engine.add_plugin(plugin);
        }
        for (kind, listener) in listeners {
            engine.on(kind, event_listener(listener));
        }
        Ok(())
    })
}

#[pymethods]
impl PyNarsil {
    #[new]
    #[pyo3(signature = (config = None))]
    fn new(py: Python<'_>, config: Option<&Bound<'_, PyAny>>) -> PyResult<PyNarsil> {
        let retained = RetainedSet::default();
        let setup = retained
            .collect(|| engine_setup(config))
            .map_err(to_py_err)?;
        let engine = py.detach(move || open_engine(setup)).map_err(to_py_err)?;
        Ok(PyNarsil {
            handle: Arc::new(EngineHandle {
                engine: Some(engine),
            }),
            listeners: Mutex::new(HashMap::new()),
            next_listener: AtomicU64::new(1),
            retained,
        })
    }

    fn __traverse__(&self, visit: PyVisit<'_>) -> Result<(), PyTraverseError> {
        self.retained.traverse(&visit)
    }

    fn __clear__(&self) {
        self.retained.release();
    }

    fn create_index(&self, py: Python<'_>, name: &str, config: &Bound<'_, PyAny>) -> PyResult<()> {
        let config = self
            .retained
            .collect(|| index_config(config, "config"))
            .map_err(to_py_err)?;
        let engine = self.handle.engine()?;
        py.detach(|| engine.create_index(name, config))
            .map_err(to_py_err)
    }

    fn drop_index(&self, py: Python<'_>, name: &str) -> PyResult<()> {
        let engine = self.handle.engine()?;
        py.detach(|| engine.drop_index(name)).map_err(to_py_err)
    }

    fn list_indexes<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyList>> {
        let engine = self.handle.engine()?;
        let indexes = py.detach(|| engine.list_indexes());
        let list = PyList::empty(py);
        for info in &indexes {
            list.append(index_info(py, info)?)?;
        }
        Ok(list)
    }

    fn open_index(&self, py: Python<'_>, name: &str) -> PyResult<()> {
        let engine = self.handle.engine()?;
        py.detach(|| engine.open_index(name)).map_err(to_py_err)
    }

    fn close_index(&self, py: Python<'_>, name: &str) -> PyResult<()> {
        let engine = self.handle.engine()?;
        py.detach(|| engine.close_index(name)).map_err(to_py_err)
    }

    fn shutdown(&self, py: Python<'_>) -> PyResult<()> {
        let engine = self.handle.engine()?;
        py.detach(|| engine.shutdown()).map_err(to_py_err)?;
        self.retained.release();
        Ok(())
    }

    #[getter]
    fn query_suggestions(slf: &Bound<'_, Self>) -> PyQuerySuggestions {
        PyQuerySuggestions {
            owner: slf.clone().unbind(),
        }
    }

    fn __enter__(slf: Bound<'_, Self>) -> Bound<'_, Self> {
        slf
    }

    #[pyo3(signature = (*_exception))]
    fn __exit__(
        &self,
        py: Python<'_>,
        _exception: &Bound<'_, pyo3::types::PyTuple>,
    ) -> PyResult<bool> {
        self.shutdown(py)?;
        Ok(false)
    }
}
