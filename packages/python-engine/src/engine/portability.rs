use narsil::SnapshotOptions;
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyDict};

use super::PyNarsil;
use crate::convert::results::import_result;
use crate::errors::to_py_err;
use crate::io::{read_from, sink_of, source_of, write_to};

fn written<'py>(py: Python<'py>, bytes: Option<Vec<u8>>) -> Option<Bound<'py, PyBytes>> {
    bytes.map(|bytes| PyBytes::new(py, &bytes))
}

#[pymethods]
impl PyNarsil {
    #[pyo3(signature = (index, destination = None, *, query_history = false))]
    fn snapshot<'py>(
        &self,
        py: Python<'py>,
        index: &str,
        destination: Option<&Bound<'py, PyAny>>,
        query_history: bool,
    ) -> PyResult<Option<Bound<'py, PyBytes>>> {
        let sink = sink_of(destination).map_err(to_py_err)?;
        let engine = self.handle.engine()?;
        let options = SnapshotOptions { query_history };
        let bytes = py
            .detach(|| write_to(sink, |out| engine.snapshot_with(index, out, &options)))
            .map_err(to_py_err)?;
        Ok(written(py, bytes))
    }

    fn restore(&self, py: Python<'_>, index: &str, source: &Bound<'_, PyAny>) -> PyResult<()> {
        let source = source_of(source).map_err(to_py_err)?;
        let engine = self.handle.engine()?;
        py.detach(|| read_from(source, |data| engine.restore(index, data)))
            .map_err(to_py_err)
    }

    #[pyo3(signature = (index, destination = None))]
    fn export_documents<'py>(
        &self,
        py: Python<'py>,
        index: &str,
        destination: Option<&Bound<'py, PyAny>>,
    ) -> PyResult<Option<Bound<'py, PyBytes>>> {
        let sink = sink_of(destination).map_err(to_py_err)?;
        let engine = self.handle.engine()?;
        let bytes = py
            .detach(|| write_to(sink, |out| engine.export_documents(index, out)))
            .map_err(to_py_err)?;
        Ok(written(py, bytes))
    }

    fn import_documents<'py>(
        &self,
        py: Python<'py>,
        index: &str,
        source: &Bound<'py, PyAny>,
    ) -> PyResult<Bound<'py, PyDict>> {
        let source = source_of(source).map_err(to_py_err)?;
        let engine = self.handle.engine()?;
        let result = py
            .detach(|| read_from(source, |data| engine.import_documents(index, data)))
            .map_err(to_py_err)?;
        import_result(py, &result)
    }
}
