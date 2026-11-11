use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList};

use super::PyNarsil;
use crate::convert::encode::synonyms;
use crate::convert::index_config::{partition_config, synonym_rules};
use crate::convert::operations::{analysis_change, sync_setting};
use crate::convert::query::bm25_params;
use crate::convert::results::{
    index_stats, memory_stats, partition_stats, sync_status, vector_maintenance,
};
use crate::errors::to_py_err;

#[pymethods]
impl PyNarsil {
    fn rebalance(
        &self,
        py: Python<'_>,
        index: &str,
        target_partition_count: usize,
    ) -> PyResult<()> {
        let engine = self.handle.engine()?;
        py.detach(|| engine.rebalance(index, target_partition_count))
            .map_err(to_py_err)
    }

    fn change_analysis(
        &self,
        py: Python<'_>,
        index: &str,
        change: &Bound<'_, PyAny>,
    ) -> PyResult<()> {
        let change = self
            .retained
            .collect(|| analysis_change(change))
            .map_err(to_py_err)?;
        let engine = self.handle.engine()?;
        py.detach(|| engine.change_analysis(index, &change))
            .map_err(to_py_err)
    }

    fn rebuild_analysis(&self, py: Python<'_>, index: &str) -> PyResult<()> {
        let engine = self.handle.engine()?;
        py.detach(|| engine.rebuild_analysis(index))
            .map_err(to_py_err)
    }

    fn update_bm25(&self, py: Python<'_>, index: &str, params: &Bound<'_, PyAny>) -> PyResult<()> {
        let params = bm25_params(params, "bm25").map_err(to_py_err)?;
        let engine = self.handle.engine()?;
        py.detach(|| engine.update_bm25(index, &params))
            .map_err(to_py_err)
    }

    fn update_partition_config(
        &self,
        py: Python<'_>,
        index: &str,
        partitions: &Bound<'_, PyAny>,
    ) -> PyResult<()> {
        let partitions = partition_config(partitions, "partitions").map_err(to_py_err)?;
        let engine = self.handle.engine()?;
        py.detach(|| engine.update_partition_config(index, &partitions))
            .map_err(to_py_err)
    }

    fn update_synonyms(
        &self,
        py: Python<'_>,
        index: &str,
        rules: &Bound<'_, PyAny>,
    ) -> PyResult<()> {
        let rules = synonym_rules(rules, "rules").map_err(to_py_err)?;
        let engine = self.handle.engine()?;
        py.detach(|| engine.update_synonyms(index, &rules))
            .map_err(to_py_err)
    }

    fn get_synonyms<'py>(&self, py: Python<'py>, index: &str) -> PyResult<Bound<'py, PyList>> {
        let engine = self.handle.engine()?;
        let rules = py
            .detach(|| engine.get_synonyms(index))
            .map_err(to_py_err)?;
        synonyms(py, &rules)
    }

    #[pyo3(signature = (index, field = None))]
    fn compact_vectors(&self, py: Python<'_>, index: &str, field: Option<&str>) -> PyResult<()> {
        let engine = self.handle.engine()?;
        py.detach(|| engine.compact_vectors(index, field))
            .map_err(to_py_err)
    }

    #[pyo3(signature = (index, field = None))]
    fn optimize_vectors(&self, py: Python<'_>, index: &str, field: Option<&str>) -> PyResult<()> {
        let engine = self.handle.engine()?;
        py.detach(|| engine.optimize_vectors(index, field))
            .map_err(to_py_err)
    }

    fn vector_maintenance_status<'py>(
        &self,
        py: Python<'py>,
        index: &str,
    ) -> PyResult<Bound<'py, PyList>> {
        let engine = self.handle.engine()?;
        let statuses = py
            .detach(|| engine.vector_maintenance_status(index))
            .map_err(to_py_err)?;
        vector_maintenance(py, &statuses)
    }

    fn checkpoint(&self, py: Python<'_>, index: &str) -> PyResult<()> {
        let engine = self.handle.engine()?;
        py.detach(|| engine.checkpoint(index)).map_err(to_py_err)
    }

    fn update_sync(&self, py: Python<'_>, index: &str, setting: &Bound<'_, PyAny>) -> PyResult<()> {
        let setting = sync_setting(setting).map_err(to_py_err)?;
        let engine = self.handle.engine()?;
        py.detach(|| engine.update_sync(index, &setting))
            .map_err(to_py_err)
    }

    fn get_sync<'py>(&self, py: Python<'py>, index: &str) -> PyResult<Bound<'py, PyDict>> {
        let engine = self.handle.engine()?;
        let status = py.detach(|| engine.get_sync(index)).map_err(to_py_err)?;
        sync_status(py, &status)
    }

    fn get_stats<'py>(&self, py: Python<'py>, index: &str) -> PyResult<Bound<'py, PyDict>> {
        let engine = self.handle.engine()?;
        let stats = py.detach(|| engine.get_stats(index)).map_err(to_py_err)?;
        index_stats(py, &stats)
    }

    fn get_partition_stats<'py>(
        &self,
        py: Python<'py>,
        index: &str,
    ) -> PyResult<Bound<'py, PyList>> {
        let engine = self.handle.engine()?;
        let stats = py
            .detach(|| engine.get_partition_stats(index))
            .map_err(to_py_err)?;
        partition_stats(py, &stats)
    }

    fn get_memory_stats<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyDict>> {
        let engine = self.handle.engine()?;
        let stats = py.detach(|| engine.get_memory_stats());
        memory_stats(py, &stats)
    }
}
