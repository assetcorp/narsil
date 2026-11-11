use std::sync::Arc;

use narsil::{
    EarlierLayout, ErrorCode, GroupReducer, IdGenerator, NarsilError, NarsilEvent, NarsilEventKind,
    QuerySuggestionsBuildPhase, StaleAnalysis, StaleAnalysisListener, StaleRebuild, Value,
    WorkStatus,
};
use pyo3::prelude::*;
use pyo3::types::PyDict;

use super::retained::Retained;
use super::{call_python, report_unraisable};
use crate::convert::fields::{Fields, string_of};
use crate::convert::value::{ValueSource, map_to_py, to_value, value_to_py};
use crate::errors::{config_invalid, to_py_err};

const ID_GENERATOR_SUBJECT: &str = "The idGenerator";
const REDUCER_RESULT_SUBJECT: &str = "The value that the reducer returned";

pub(crate) fn id_generator(
    function: &Bound<'_, PyAny>,
    label: &str,
) -> Result<IdGenerator, NarsilError> {
    if !function.is_callable() {
        return Err(config_invalid(format!("{label} must be a function")));
    }
    let function = Retained::new(function);
    Ok(Arc::new(move || {
        let generated = call_python(ErrorCode::INTERNAL_ERROR, ID_GENERATOR_SUBJECT, |py| {
            let id = function.bind(py)?.call0()?;
            Ok(string_of(&id, "the ID that the idGenerator returned")?)
        });
        match generated {
            Ok(id) => id,
            Err(error) => std::panic::resume_unwind(Box::new(error)),
        }
    }))
}

pub(crate) const EVENT_KINDS: [(&str, NarsilEventKind); 8] = [
    ("write", NarsilEventKind::Write),
    ("partitionRebalance", NarsilEventKind::PartitionRebalance),
    ("partitionWatermark", NarsilEventKind::PartitionWatermark),
    ("analysisRebuild", NarsilEventKind::AnalysisRebuild),
    ("layoutUpgrade", NarsilEventKind::LayoutUpgrade),
    ("durabilityError", NarsilEventKind::DurabilityError),
    (
        "querySuggestionsBuild",
        NarsilEventKind::QuerySuggestionsBuild,
    ),
    (
        "querySuggestionsWarning",
        NarsilEventKind::QuerySuggestionsWarning,
    ),
];

fn work_status(status: WorkStatus) -> &'static str {
    match status {
        WorkStatus::Started => "started",
        WorkStatus::Completed => "completed",
        WorkStatus::Failed => "failed",
    }
}

fn build_phase(phase: QuerySuggestionsBuildPhase) -> &'static str {
    match phase {
        QuerySuggestionsBuildPhase::Started => "started",
        QuerySuggestionsBuildPhase::Completed => "completed",
        QuerySuggestionsBuildPhase::Failed => "failed",
        QuerySuggestionsBuildPhase::Skipped => "skipped",
    }
}

fn error_value(py: Python<'_>, error: Option<&NarsilError>) -> Option<Py<PyAny>> {
    error.map(|error| to_py_err(error.clone()).into_value(py).into_any())
}

pub(crate) fn event_payload<'py>(
    py: Python<'py>,
    event: &NarsilEvent,
) -> PyResult<Bound<'py, PyDict>> {
    let payload = PyDict::new(py);
    match event {
        NarsilEvent::Write { index_name } => payload.set_item("indexName", index_name)?,
        NarsilEvent::PartitionRebalance {
            index_name,
            old_count,
            new_count,
        } => {
            payload.set_item("indexName", index_name)?;
            payload.set_item("oldCount", old_count)?;
            payload.set_item("newCount", new_count)?;
        }
        NarsilEvent::PartitionWatermark {
            index_name,
            document_count,
            capacity,
            partition_count,
        } => {
            payload.set_item("indexName", index_name)?;
            payload.set_item("documentCount", document_count)?;
            payload.set_item("capacity", capacity)?;
            payload.set_item("partitionCount", partition_count)?;
        }
        NarsilEvent::AnalysisRebuild {
            index_name,
            status,
            partitions_rebuilt,
            partition_count,
            error,
        } => {
            payload.set_item("indexName", index_name)?;
            payload.set_item("status", work_status(*status))?;
            payload.set_item("partitionsRebuilt", partitions_rebuilt)?;
            payload.set_item("partitionCount", partition_count)?;
            payload.set_item("error", error_value(py, error.as_ref()))?;
        }
        NarsilEvent::LayoutUpgrade {
            index_name,
            status,
            layout,
            error,
        } => {
            payload.set_item("indexName", index_name)?;
            payload.set_item("status", work_status(*status))?;
            let layout = match layout {
                EarlierLayout::Manifest => "manifest",
                EarlierLayout::Bundle => "bundle",
            };
            payload.set_item("layout", layout)?;
            payload.set_item("error", error_value(py, error.as_ref()))?;
        }
        NarsilEvent::DurabilityError { index_name, error } => {
            payload.set_item("indexName", index_name)?;
            payload.set_item("error", error_value(py, Some(error)))?;
        }
        NarsilEvent::QuerySuggestionsBuild {
            index_name,
            build_id,
            phase,
            trigger,
            published,
            removed,
            discarded,
            error_code,
        } => {
            payload.set_item("indexName", index_name)?;
            payload.set_item("buildId", build_id)?;
            payload.set_item("phase", build_phase(*phase))?;
            payload.set_item("trigger", trigger.as_str())?;
            payload.set_item("published", published)?;
            payload.set_item("removed", removed)?;
            payload.set_item("discarded", discarded)?;
            payload.set_item("errorCode", error_code.as_deref())?;
        }
        NarsilEvent::QuerySuggestionsWarning {
            index_name,
            reason,
            file,
            message,
        } => {
            payload.set_item("indexName", index_name)?;
            payload.set_item("reason", reason.as_str())?;
            payload.set_item("file", file.as_deref())?;
            payload.set_item("message", message.as_deref())?;
        }
        _ => {}
    }
    Ok(payload)
}

pub(crate) fn event_listener(function: Retained) -> impl Fn(&NarsilEvent) + Send + Sync + 'static {
    move |event: &NarsilEvent| {
        let _ = Python::try_attach(|py| {
            let Ok(listener) = function.bind(py) else {
                return;
            };
            let outcome = event_payload(py, event).and_then(|payload| listener.call1((payload,)));
            if let Err(error) = outcome {
                report_unraisable(py, error, &listener);
            }
        });
    }
}

/// This handle rebuilds one index whose stored analysis differs from its language module, when the
/// `analysis.onStaleAnalysis` function calls it.
#[pyclass(frozen, module = "narsil._native", name = "StaleRebuild")]
pub(crate) struct PyStaleRebuild {
    rebuild: StaleRebuild,
}

#[pymethods]
impl PyStaleRebuild {
    #[getter]
    fn index_name(&self) -> &str {
        self.rebuild.index_name()
    }

    fn __call__(&self, py: Python<'_>) -> PyResult<()> {
        py.detach(|| self.rebuild.run()).map_err(to_py_err)
    }
}

pub(crate) fn stale_listener(
    function: &Bound<'_, PyAny>,
    label: &str,
) -> Result<StaleAnalysisListener, NarsilError> {
    if !function.is_callable() {
        return Err(config_invalid(format!("{label} must be a function")));
    }
    let function = Retained::new(function);
    Ok(Arc::new(
        move |facts: &StaleAnalysis, rebuild: StaleRebuild| {
            let _ = Python::try_attach(|py| {
                let Ok(listener) = function.bind(py) else {
                    return;
                };
                let outcome = (|| -> PyResult<()> {
                    let payload = PyDict::new(py);
                    payload.set_item("indexName", &facts.index_name)?;
                    payload.set_item("language", &facts.language)?;
                    payload.set_item("storedRevision", facts.stored_revision.as_deref())?;
                    payload.set_item("currentRevision", &facts.current_revision)?;
                    payload.set_item("documentCount", facts.document_count)?;
                    listener.call1((payload, PyStaleRebuild { rebuild }))?;
                    Ok(())
                })();
                if let Err(error) = outcome {
                    report_unraisable(py, error, &listener);
                }
            });
        },
    ))
}

/// This handle holds the reducer of a grouped query, so that a `before_search` hook that receives the query as a
/// dict can return the same reducer.
#[pyclass(frozen, module = "narsil._native", name = "GroupReducerHandle")]
pub(crate) struct GroupReducerHandle {
    pub(crate) reducer: GroupReducer,
}

fn reducer_function(fields: &mut Fields<'_>, key: &'static str) -> Result<Py<PyAny>, NarsilError> {
    let path = fields.path(key);
    match fields.get(key)? {
        Some(function) if function.is_callable() => Ok(function.unbind()),
        _ => Err(config_invalid(format!("{path} must be a function"))),
    }
}

pub(crate) fn group_reducer(
    value: &Bound<'_, PyAny>,
    label: &str,
) -> Result<GroupReducer, NarsilError> {
    if let Ok(handle) = value.cast::<GroupReducerHandle>() {
        return Ok(handle.get().reducer.clone());
    }
    let mut fields = Fields::of(value, label)?;
    let reducer = Arc::new(reducer_function(&mut fields, "reducer")?);
    let initial = reducer_function(&mut fields, "initialValue")?;
    fields.finish()?;
    let source = ValueSource {
        code: ErrorCode::CONFIG_INVALID,
        subject: REDUCER_RESULT_SUBJECT,
    };
    Ok(GroupReducer {
        reducer: Arc::new(move |accumulator: Value, document, score| {
            Python::try_attach(|py| {
                let folded = (|| -> PyResult<Bound<'_, PyAny>> {
                    reducer.bind(py).call1((
                        value_to_py(py, &accumulator)?,
                        map_to_py(py, document)?,
                        score,
                    ))
                })();
                match folded {
                    Ok(next) => {
                        to_value(&next, source).map_err(|error| error.message().to_string())
                    }
                    Err(error) => Err(crate::errors::callback_error(
                        py,
                        &error,
                        ErrorCode::CONFIG_INVALID,
                        "The reducer",
                    )
                    .message()
                    .to_string()),
                }
            })
            .unwrap_or_else(|| {
                Err(
                    "The reducer is unavailable because the Python interpreter is shutting down"
                        .to_string(),
                )
            })
        }),
        initial_value: Arc::new(move || {
            let started = call_python(
                ErrorCode::CONFIG_INVALID,
                "The initialValue function",
                |py| {
                    let initial = initial.bind(py).call0()?;
                    Ok(to_value(&initial, source)?)
                },
            );
            match started {
                Ok(value) => value,
                Err(error) => std::panic::resume_unwind(Box::new(error.message().to_string())),
            }
        }),
    })
}
