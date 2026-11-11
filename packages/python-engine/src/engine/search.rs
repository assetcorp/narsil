use pyo3::prelude::*;
use pyo3::types::PyDict;

use super::PyNarsil;
use crate::convert::operations::{list_params, suggest_params};
use crate::convert::query::{ConvertedQuery, converted_query, with_text_refusal};
use crate::convert::results::{list_result, preflight_result, query_result, suggest_result};
use crate::errors::to_py_err;

#[pymethods]
impl PyNarsil {
    fn query<'py>(
        &self,
        py: Python<'py>,
        index: &str,
        params: &Bound<'py, PyAny>,
    ) -> PyResult<Bound<'py, PyDict>> {
        let ConvertedQuery {
            params,
            text_refusal,
        } = converted_query(params, "params").map_err(to_py_err)?;
        let engine = self.handle.engine()?;
        let result = py
            .detach(|| engine.query(index, &params))
            .map_err(|error| to_py_err(with_text_refusal(error, text_refusal)))?;
        query_result(py, &result)
    }

    fn preflight<'py>(
        &self,
        py: Python<'py>,
        index: &str,
        params: &Bound<'py, PyAny>,
    ) -> PyResult<Bound<'py, PyDict>> {
        let ConvertedQuery {
            params,
            text_refusal,
        } = converted_query(params, "params").map_err(to_py_err)?;
        let engine = self.handle.engine()?;
        let result = py
            .detach(|| engine.preflight(index, &params))
            .map_err(|error| to_py_err(with_text_refusal(error, text_refusal)))?;
        preflight_result(py, &result)
    }

    fn suggest<'py>(
        &self,
        py: Python<'py>,
        index: &str,
        params: &Bound<'py, PyAny>,
    ) -> PyResult<Bound<'py, PyDict>> {
        let params = suggest_params(params).map_err(to_py_err)?;
        let engine = self.handle.engine()?;
        let result = py
            .detach(|| engine.suggest(index, &params))
            .map_err(to_py_err)?;
        suggest_result(py, &result)
    }

    #[pyo3(signature = (index, params = None))]
    fn list_documents<'py>(
        &self,
        py: Python<'py>,
        index: &str,
        params: Option<&Bound<'py, PyAny>>,
    ) -> PyResult<Bound<'py, PyDict>> {
        let params = list_params(params).map_err(to_py_err)?;
        let engine = self.handle.engine()?;
        let result = py
            .detach(|| engine.list_documents(index, &params))
            .map_err(to_py_err)?;
        list_result(py, &result)
    }
}
