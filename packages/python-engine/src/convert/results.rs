use std::collections::BTreeMap;
use std::time::Duration;

use narsil::{
    BatchResult, DocumentImportResult, FacetResult, GroupResult, HighlightMatch, Hit, IndexInfo,
    IndexResidencyState, IndexStats, ListResult, MemoryStats, PartitionStats, PreflightResult,
    QueryResult, ScoreComponents, SuggestResult, SyncStatus, VectorMaintenanceStatus,
};
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList};

use super::value::{map_to_py, value_to_py};
use crate::constants::MILLISECONDS_PER_SECOND;
use crate::errors::to_py_err;

pub(crate) fn milliseconds(elapsed: Duration) -> f64 {
    elapsed.as_secs_f64() * MILLISECONDS_PER_SECOND
}

fn numbers<'py>(py: Python<'py>, numbers: &BTreeMap<String, f64>) -> PyResult<Bound<'py, PyDict>> {
    let dict = PyDict::new(py);
    for (key, number) in numbers {
        dict.set_item(key, number)?;
    }
    Ok(dict)
}

fn score_components<'py>(
    py: Python<'py>,
    components: &ScoreComponents,
) -> PyResult<Bound<'py, PyDict>> {
    let dict = PyDict::new(py);
    dict.set_item(
        "termFrequencies",
        numbers(py, &components.term_frequencies)?,
    )?;
    dict.set_item("fieldLengths", numbers(py, &components.field_lengths)?)?;
    dict.set_item("idf", numbers(py, &components.idf)?)?;
    Ok(dict)
}

fn highlight<'py>(py: Python<'py>, matched: &HighlightMatch) -> PyResult<Bound<'py, PyDict>> {
    let dict = PyDict::new(py);
    dict.set_item("snippet", &matched.snippet)?;
    let positions = PyList::empty(py);
    for position in &matched.positions {
        let entry = PyDict::new(py);
        entry.set_item("start", position.start)?;
        entry.set_item("end", position.end)?;
        positions.append(entry)?;
    }
    dict.set_item("positions", positions)?;
    Ok(dict)
}

fn hit<'py>(py: Python<'py>, hit: &Hit) -> PyResult<Bound<'py, PyDict>> {
    let dict = PyDict::new(py);
    dict.set_item("id", &hit.id)?;
    dict.set_item("score", hit.score)?;
    dict.set_item("document", map_to_py(py, &hit.document)?)?;
    let components = hit
        .score_components
        .as_ref()
        .map(|components| score_components(py, components))
        .transpose()?;
    dict.set_item("scoreComponents", components)?;
    let highlights = match &hit.highlights {
        None => None,
        Some(highlights) => {
            let fields = PyDict::new(py);
            for (field, matched) in highlights {
                fields.set_item(field, highlight(py, matched)?)?;
            }
            Some(fields)
        }
    };
    dict.set_item("highlights", highlights)?;
    Ok(dict)
}

fn hits<'py>(py: Python<'py>, hits: &[Hit]) -> PyResult<Bound<'py, PyList>> {
    let list = PyList::empty(py);
    for found in hits {
        list.append(hit(py, found)?)?;
    }
    Ok(list)
}

fn facet<'py>(py: Python<'py>, facet: &FacetResult) -> PyResult<Bound<'py, PyDict>> {
    let dict = PyDict::new(py);
    let values = PyDict::new(py);
    for (value, count) in &facet.values {
        values.set_item(value, count)?;
    }
    dict.set_item("values", values)?;
    dict.set_item("count", facet.count)?;
    dict.set_item("errorBound", facet.error_bound)?;
    Ok(dict)
}

fn group<'py>(py: Python<'py>, group: &GroupResult) -> PyResult<Bound<'py, PyDict>> {
    let dict = PyDict::new(py);
    let values = PyDict::new(py);
    for (field, value) in &group.values {
        let value = value
            .as_ref()
            .map(|value| value_to_py(py, value))
            .transpose()?;
        values.set_item(field, value)?;
    }
    dict.set_item("values", values)?;
    dict.set_item("hits", hits(py, &group.hits)?)?;
    let reduced = group
        .reduced
        .as_ref()
        .map(|value| value_to_py(py, value))
        .transpose()?;
    dict.set_item("reduced", reduced)?;
    dict.set_item("reducerError", group.reducer_error.as_deref())?;
    Ok(dict)
}

pub(crate) fn query_result<'py>(
    py: Python<'py>,
    result: &QueryResult,
) -> PyResult<Bound<'py, PyDict>> {
    let dict = PyDict::new(py);
    dict.set_item("hits", hits(py, &result.hits)?)?;
    dict.set_item("count", result.count)?;
    dict.set_item("countExact", result.count_exact)?;
    dict.set_item("elapsed", milliseconds(result.elapsed))?;
    dict.set_item("cursor", result.cursor.as_deref())?;
    let facets = match &result.facets {
        None => None,
        Some(facets) => {
            let fields = PyDict::new(py);
            for (field, counts) in facets {
                fields.set_item(field, facet(py, counts)?)?;
            }
            Some(fields)
        }
    };
    dict.set_item("facets", facets)?;
    let groups = match &result.groups {
        None => None,
        Some(groups) => {
            let list = PyList::empty(py);
            for found in groups {
                list.append(group(py, found)?)?;
            }
            Some(list)
        }
    };
    dict.set_item("groups", groups)?;
    dict.set_item("analysisStale", result.analysis_stale)?;
    let coverage = PyDict::new(py);
    coverage.set_item("totalPartitions", result.coverage.total_partitions)?;
    coverage.set_item("queriedPartitions", result.coverage.queried_partitions)?;
    coverage.set_item("timedOutPartitions", result.coverage.timed_out_partitions)?;
    coverage.set_item("failedPartitions", result.coverage.failed_partitions)?;
    dict.set_item("coverage", coverage)?;
    Ok(dict)
}

pub(crate) fn preflight_result<'py>(
    py: Python<'py>,
    result: &PreflightResult,
) -> PyResult<Bound<'py, PyDict>> {
    let dict = PyDict::new(py);
    dict.set_item("count", result.count)?;
    dict.set_item("countExact", result.count_exact)?;
    dict.set_item("elapsed", milliseconds(result.elapsed))?;
    dict.set_item("analysisStale", result.analysis_stale)?;
    Ok(dict)
}

pub(crate) fn batch_result<'py>(
    py: Python<'py>,
    result: BatchResult,
) -> PyResult<Bound<'py, PyDict>> {
    let dict = PyDict::new(py);
    dict.set_item("succeeded", PyList::new(py, &result.succeeded)?)?;
    let failed = PyList::empty(py);
    for failure in result.failed {
        let entry = PyDict::new(py);
        entry.set_item("docId", failure.doc_id)?;
        entry.set_item("error", to_py_err(failure.error).into_value(py))?;
        failed.append(entry)?;
    }
    dict.set_item("failed", failed)?;
    Ok(dict)
}

pub(crate) fn import_result<'py>(
    py: Python<'py>,
    result: &DocumentImportResult,
) -> PyResult<Bound<'py, PyDict>> {
    let dict = PyDict::new(py);
    dict.set_item("imported", result.imported)?;
    dict.set_item("refusedCount", result.refused_count)?;
    let refused = PyList::empty(py);
    for refusal in &result.refused {
        let entry = PyDict::new(py);
        entry.set_item("line", refusal.line)?;
        entry.set_item("code", refusal.code.as_str())?;
        entry.set_item("message", &refusal.message)?;
        refused.append(entry)?;
    }
    dict.set_item("refused", refused)?;
    Ok(dict)
}

fn residency(state: IndexResidencyState) -> &'static str {
    match state {
        IndexResidencyState::Open => "open",
        IndexResidencyState::Closed => "closed",
        IndexResidencyState::ReopenFailed => "reopen-failed",
    }
}

pub(crate) fn index_info<'py>(py: Python<'py>, info: &IndexInfo) -> PyResult<Bound<'py, PyDict>> {
    let dict = PyDict::new(py);
    dict.set_item("name", &info.name)?;
    dict.set_item("documentCount", info.document_count)?;
    dict.set_item("partitionCount", info.partition_count)?;
    dict.set_item("language", &info.language)?;
    dict.set_item("analysisStale", info.analysis_stale)?;
    dict.set_item("state", residency(info.state))?;
    dict.set_item("reopenCount", info.reopen_count)?;
    Ok(dict)
}

pub(crate) fn index_stats<'py>(
    py: Python<'py>,
    stats: &IndexStats,
) -> PyResult<Bound<'py, PyDict>> {
    let dict = PyDict::new(py);
    dict.set_item("documentCount", stats.document_count)?;
    dict.set_item("partitionCount", stats.partition_count)?;
    dict.set_item("estimatedMemoryBytes", stats.estimated_memory_bytes)?;
    dict.set_item("language", &stats.language)?;
    dict.set_item("schema", value_to_py(py, &stats.schema)?)?;
    Ok(dict)
}

pub(crate) fn partition_stats<'py>(
    py: Python<'py>,
    stats: &[PartitionStats],
) -> PyResult<Bound<'py, PyList>> {
    let list = PyList::empty(py);
    for partition in stats {
        let dict = PyDict::new(py);
        dict.set_item("partitionId", partition.partition_id)?;
        dict.set_item("documentCount", partition.document_count)?;
        dict.set_item("estimatedMemoryBytes", partition.estimated_memory_bytes)?;
        list.append(dict)?;
    }
    Ok(list)
}

pub(crate) fn memory_stats<'py>(
    py: Python<'py>,
    stats: &MemoryStats,
) -> PyResult<Bound<'py, PyDict>> {
    let dict = PyDict::new(py);
    dict.set_item("processResidentBytes", stats.process_resident_bytes)?;
    dict.set_item("estimatedIndexBytes", stats.estimated_index_bytes)?;
    dict.set_item("openIndexCount", stats.open_index_count)?;
    Ok(dict)
}

pub(crate) fn suggest_result<'py>(
    py: Python<'py>,
    result: &SuggestResult,
) -> PyResult<Bound<'py, PyDict>> {
    let dict = PyDict::new(py);
    let terms = PyList::empty(py);
    for term in &result.terms {
        let entry = PyDict::new(py);
        entry.set_item("term", &term.term)?;
        entry.set_item("documentFrequency", term.document_frequency)?;
        terms.append(entry)?;
    }
    dict.set_item("terms", terms)?;
    dict.set_item("elapsed", milliseconds(result.elapsed))?;
    dict.set_item("analysisStale", result.analysis_stale)?;
    Ok(dict)
}

pub(crate) fn list_result<'py>(
    py: Python<'py>,
    result: &ListResult,
) -> PyResult<Bound<'py, PyDict>> {
    let dict = PyDict::new(py);
    let documents = PyList::empty(py);
    for listed in &result.documents {
        let entry = PyDict::new(py);
        entry.set_item("id", &listed.id)?;
        entry.set_item("document", map_to_py(py, &listed.document)?)?;
        documents.append(entry)?;
    }
    dict.set_item("documents", documents)?;
    dict.set_item("cursor", result.cursor.as_deref())?;
    dict.set_item("total", result.total)?;
    dict.set_item("elapsed", milliseconds(result.elapsed))?;
    Ok(dict)
}

pub(crate) fn vector_maintenance<'py>(
    py: Python<'py>,
    statuses: &[VectorMaintenanceStatus],
) -> PyResult<Bound<'py, PyList>> {
    let list = PyList::empty(py);
    for status in statuses {
        let dict = PyDict::new(py);
        dict.set_item("fieldName", &status.field_name)?;
        dict.set_item("tombstoneRatio", status.tombstone_ratio)?;
        dict.set_item("graphCount", status.graph_count)?;
        dict.set_item("bufferSize", status.buffer_size)?;
        dict.set_item("building", status.building)?;
        dict.set_item("waitingForMemory", status.waiting_for_memory)?;
        dict.set_item("loadingFromFiles", status.loading_from_files)?;
        dict.set_item("estimatedCompactMs", status.estimated_compact_ms)?;
        dict.set_item("estimatedOptimizeMs", status.estimated_optimize_ms)?;
        list.append(dict)?;
    }
    Ok(list)
}

pub(crate) fn sync_status<'py>(
    py: Python<'py>,
    status: &SyncStatus,
) -> PyResult<Bound<'py, PyDict>> {
    let dict = PyDict::new(py);
    dict.set_item("enabled", status.enabled)?;
    dict.set_item("historyMaxAgeMs", status.history_max_age_ms)?;
    dict.set_item("historyMaxBytes", status.history_max_bytes)?;
    dict.set_item("active", status.active)?;
    dict.set_item("epoch", status.epoch.as_deref())?;
    Ok(dict)
}
