use narsil::{ErrorCode, Narsil, NarsilError, QueryParams};
use pyo3::prelude::*;
use pyo3::types::PyDict;

use super::PyNarsil;
use crate::convert::operations::{list_params, suggest_params};
use crate::convert::query::{ConvertedQuery, converted_query};
use crate::convert::results::{list_result, preflight_result, query_result, suggest_result};
use crate::errors::to_py_err;

fn text_refusal_on(
    engine: &Narsil,
    index: &str,
    params_with_empty_text: &QueryParams,
    refusal: NarsilError,
) -> NarsilError {
    match engine.preflight(index, params_with_empty_text) {
        Err(error) if error.code() != ErrorCode::DOC_VALIDATION_FAILED => error,
        _ => refusal,
    }
}

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
        if let Some(refusal) = text_refusal {
            return Err(to_py_err(
                py.detach(|| text_refusal_on(engine, index, &params, refusal)),
            ));
        }
        let result = py
            .detach(|| engine.query(index, &params))
            .map_err(to_py_err)?;
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
        if let Some(refusal) = text_refusal {
            return Err(to_py_err(
                py.detach(|| text_refusal_on(engine, index, &params, refusal)),
            ));
        }
        let result = py
            .detach(|| engine.preflight(index, &params))
            .map_err(to_py_err)?;
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
