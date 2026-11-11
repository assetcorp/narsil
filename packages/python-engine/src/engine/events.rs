use std::sync::atomic::Ordering;

use pyo3::prelude::*;

use super::PyNarsil;
use crate::callbacks::adapters::{PythonEmbeddingAdapter, PythonRerankAdapter};
use crate::callbacks::analysis::{stop_words_value, tokenizer_object};
use crate::callbacks::functions::{EVENT_KINDS, event_listener};
use crate::callbacks::plugins::PythonPlugin;
use crate::callbacks::retained::Retained;
use crate::convert::fields::choice_of;
use crate::errors::{config_invalid, to_py_err};

#[pymethods]
impl PyNarsil {
    fn on(&self, kind: &str, listener: &Bound<'_, PyAny>) -> PyResult<u64> {
        let kind = choice_of(kind, "kind", &EVENT_KINDS).map_err(to_py_err)?;
        if !listener.is_callable() {
            return Err(to_py_err(config_invalid("listener must be a function")));
        }
        let engine = self.handle.engine()?;
        let listener = self.retained.collect(|| Retained::new(listener));
        let registered = engine.on(kind, event_listener(listener));
        let id = self.next_listener.fetch_add(1, Ordering::Relaxed);
        self.listeners
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id, registered);
        Ok(id)
    }

    fn off(&self, py: Python<'_>, listener_id: u64) -> PyResult<bool> {
        let registered = self
            .listeners
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&listener_id);
        let Some(registered) = registered else {
            return Ok(false);
        };
        let engine = self.handle.engine()?;
        let removed = py.detach(|| engine.off(registered));
        self.retained.prune();
        Ok(removed)
    }

    fn register_tokenizer(
        &self,
        py: Python<'_>,
        name: &str,
        tokenizer: &Bound<'_, PyAny>,
    ) -> PyResult<()> {
        let tokenizer = self
            .retained
            .collect(|| tokenizer_object(tokenizer, "tokenizer"))
            .map_err(to_py_err)?;
        let engine = self.handle.engine()?;
        py.detach(|| engine.register_tokenizer(name, tokenizer))
            .map_err(to_py_err)
    }

    fn register_stop_words(
        &self,
        py: Python<'_>,
        name: &str,
        stop_words: &Bound<'_, PyAny>,
    ) -> PyResult<()> {
        let stop_words = self
            .retained
            .collect(|| stop_words_value(stop_words, "stop_words"))
            .map_err(to_py_err)?;
        let engine = self.handle.engine()?;
        py.detach(|| engine.register_stop_words(name, stop_words))
            .map_err(to_py_err)
    }

    fn register_embedding_adapter(
        &self,
        py: Python<'_>,
        name: &str,
        adapter: &Bound<'_, PyAny>,
    ) -> PyResult<()> {
        let adapter = self
            .retained
            .collect(|| PythonEmbeddingAdapter::wrap(adapter, &format!("\"{name}\"")))
            .map_err(to_py_err)?;
        let engine = self.handle.engine()?;
        py.detach(|| engine.register_embedding_adapter(name, adapter))
            .map_err(to_py_err)
    }

    fn register_rerank_adapter(
        &self,
        py: Python<'_>,
        name: &str,
        adapter: &Bound<'_, PyAny>,
    ) -> PyResult<()> {
        let adapter = self
            .retained
            .collect(|| PythonRerankAdapter::wrap(adapter, name))
            .map_err(to_py_err)?;
        let engine = self.handle.engine()?;
        py.detach(|| engine.register_rerank_adapter(name, adapter))
            .map_err(to_py_err)
    }

    fn add_plugin(&self, py: Python<'_>, plugin: &Bound<'_, PyAny>) -> PyResult<()> {
        let plugin = self
            .retained
            .collect(|| PythonPlugin::wrap(plugin, "plugin"))
            .map_err(to_py_err)?;
        let engine = self.handle.engine()?;
        py.detach(|| engine.add_plugin(plugin));
        Ok(())
    }
}
