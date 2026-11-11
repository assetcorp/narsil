use narsil::NarsilError;
use pyo3::gc::{PyTraverseError, PyVisit};
use pyo3::prelude::*;
use pyo3::types::PyDict;

use super::documents::ids_of;
use super::{EngineHandle, PyNarsil};
use crate::convert::fields::whole_of;
use crate::convert::operations::{
    build_dict, manual_suggestion, preview_dict, record_dict, recorded_query, status_dict,
    suggestions_setting,
};
use crate::errors::to_py_err;

/// This class gives the popular query suggestions of an engine's indexes, and `Narsil.query_suggestions` returns
/// it.
#[pyclass(frozen, module = "narsil._native", name = "QuerySuggestions")]
pub(crate) struct PyQuerySuggestions {
    pub(crate) owner: Py<PyNarsil>,
}

impl PyQuerySuggestions {
    fn handle(&self) -> &EngineHandle {
        &self.owner.get().handle
    }
}

fn preview_limit(limit: Option<&Bound<'_, PyAny>>) -> Result<Option<u32>, NarsilError> {
    let Some(limit) = limit.filter(|limit| !limit.is_none()) else {
        return Ok(None);
    };
    let limit = whole_of(limit, "limit")?;
    Ok(Some(u32::try_from(limit).unwrap_or(u32::MAX)))
}

#[pymethods]
impl PyQuerySuggestions {
    fn __traverse__(&self, visit: PyVisit<'_>) -> Result<(), PyTraverseError> {
        visit.call(&self.owner)
    }

    fn record_query<'py>(
        &self,
        py: Python<'py>,
        index: &str,
        query: &Bound<'py, PyAny>,
    ) -> PyResult<Bound<'py, PyDict>> {
        let query = recorded_query(query).map_err(to_py_err)?;
        let engine = self.handle().engine()?;
        let result = py
            .detach(|| engine.query_suggestions().record_query(index, &query))
            .map_err(to_py_err)?;
        record_dict(py, &result)
    }

    fn update_setting(
        &self,
        py: Python<'_>,
        index: &str,
        setting: &Bound<'_, PyAny>,
    ) -> PyResult<()> {
        let setting = suggestions_setting(setting).map_err(to_py_err)?;
        let engine = self.handle().engine()?;
        py.detach(|| engine.query_suggestions().update_setting(index, &setting))
            .map_err(to_py_err)
    }

    fn status<'py>(&self, py: Python<'py>, index: &str) -> PyResult<Bound<'py, PyDict>> {
        let engine = self.handle().engine()?;
        let status = py
            .detach(|| engine.query_suggestions().status(index))
            .map_err(to_py_err)?;
        status_dict(py, &status)
    }

    fn build<'py>(&self, py: Python<'py>, index: &str) -> PyResult<Bound<'py, PyDict>> {
        let engine = self.handle().engine()?;
        let build = py
            .detach(|| engine.query_suggestions().build(index))
            .map_err(to_py_err)?;
        build_dict(py, &build)
    }

    #[pyo3(signature = (index, limit = None))]
    fn preview<'py>(
        &self,
        py: Python<'py>,
        index: &str,
        limit: Option<&Bound<'py, PyAny>>,
    ) -> PyResult<Bound<'py, PyDict>> {
        let limit = preview_limit(limit).map_err(to_py_err)?;
        let engine = self.handle().engine()?;
        let preview = py
            .detach(|| engine.query_suggestions().preview(index, limit))
            .map_err(to_py_err)?;
        preview_dict(py, &preview)
    }

    fn bans(&self, py: Python<'_>, index: &str) -> PyResult<Vec<String>> {
        let engine = self.handle().engine()?;
        py.detach(|| engine.query_suggestions().bans(index))
            .map_err(to_py_err)
    }

    fn update_bans(
        &self,
        py: Python<'_>,
        index: &str,
        phrases: &Bound<'_, PyAny>,
    ) -> PyResult<Vec<String>> {
        let phrases = ids_of(phrases)?;
        let engine = self.handle().engine()?;
        py.detach(|| engine.query_suggestions().update_bans(index, &phrases))
            .map_err(to_py_err)
    }

    fn remove_query(&self, py: Python<'_>, index: &str, query: &str) -> PyResult<u64> {
        let engine = self.handle().engine()?;
        py.detach(|| engine.query_suggestions().remove_query(index, query))
            .map_err(to_py_err)
    }

    fn add_suggestion(
        &self,
        py: Python<'_>,
        index: &str,
        suggestion: &Bound<'_, PyAny>,
    ) -> PyResult<String> {
        let suggestion = manual_suggestion(suggestion).map_err(to_py_err)?;
        let engine = self.handle().engine()?;
        py.detach(|| {
            engine
                .query_suggestions()
                .add_suggestion(index, &suggestion)
        })
        .map_err(to_py_err)
    }

    fn suggestions_index_name(&self, index: &str, group: &str) -> PyResult<String> {
        let engine = self.handle().engine()?;
        engine
            .query_suggestions()
            .suggestions_index_name(index, group)
            .map_err(to_py_err)
    }
}
