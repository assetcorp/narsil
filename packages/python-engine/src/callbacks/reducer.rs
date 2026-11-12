use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use narsil::{ErrorCode, GroupReducer, NarsilError, Value};
use pyo3::gc::{PyTraverseError, PyVisit};
use pyo3::prelude::*;

use super::call_python;
use super::reentry::Reentry;
use crate::convert::fields::Fields;
use crate::convert::value::{ValueSource, map_to_py, to_value, value_to_py};
use crate::errors::{callback_error, config_invalid};

const REDUCER_RESULT_SUBJECT: &str = "The value that the reducer returned";
const REDUCER_RESULT: ValueSource<'static> = ValueSource {
    code: ErrorCode::CONFIG_INVALID,
    subject: REDUCER_RESULT_SUBJECT,
};

struct ReducerFunctions {
    reducer: Py<PyAny>,
    initial: Py<PyAny>,
}

type FunctionPair = (Py<PyAny>, Py<PyAny>);

static REDUCER_SOURCES: Mutex<BTreeMap<usize, Weak<ReducerFunctions>>> =
    Mutex::new(BTreeMap::new());

fn reducer_sources() -> MutexGuard<'static, BTreeMap<usize, Weak<ReducerFunctions>>> {
    REDUCER_SOURCES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn source_key(reducer: &GroupReducer) -> usize {
    Arc::as_ptr(&reducer.reducer).cast::<()>().addr()
}

/// This handle holds the reducer of a grouped query, so that a `before_search` hook that receives the query as a
/// dict can return the same reducer.
#[pyclass(frozen, module = "narsil._native", name = "GroupReducerHandle")]
pub(crate) struct GroupReducerHandle {
    functions: Mutex<Option<FunctionPair>>,
}

impl GroupReducerHandle {
    pub(crate) fn of(py: Python<'_>, reducer: &GroupReducer) -> Option<GroupReducerHandle> {
        let source = reducer_sources()
            .get(&source_key(reducer))
            .and_then(Weak::upgrade)?;
        Some(GroupReducerHandle {
            functions: Mutex::new(Some((
                source.reducer.clone_ref(py),
                source.initial.clone_ref(py),
            ))),
        })
    }

    fn functions(&self) -> MutexGuard<'_, Option<FunctionPair>> {
        self.functions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn held(&self, py: Python<'_>) -> Option<FunctionPair> {
        self.functions()
            .as_ref()
            .map(|(reducer, initial)| (reducer.clone_ref(py), initial.clone_ref(py)))
    }
}

#[pymethods]
impl GroupReducerHandle {
    fn __traverse__(&self, visit: PyVisit<'_>) -> Result<(), PyTraverseError> {
        if let Some((reducer, initial)) = &*self.functions() {
            visit.call(reducer)?;
            visit.call(initial)?;
        }
        Ok(())
    }

    fn __clear__(&self) {
        let cleared = self.functions().take();
        drop(cleared);
    }
}

fn reducer_function(fields: &mut Fields<'_>, key: &'static str) -> Result<Py<PyAny>, NarsilError> {
    let path = fields.path(key);
    match fields.get(key)? {
        Some(function) if function.is_callable() => Ok(function.unbind()),
        _ => Err(config_invalid(format!("{path} must be a function"))),
    }
}

fn fold(
    functions: &ReducerFunctions,
    accumulator: Value,
    document: &narsil::Map,
    score: f64,
) -> Result<Value, String> {
    Python::try_attach(|py| {
        let folded = (|| -> PyResult<Bound<'_, PyAny>> {
            functions.reducer.bind(py).call1((
                value_to_py(py, &accumulator)?,
                map_to_py(py, document)?,
                score,
            ))
        })();
        match folded {
            Ok(next) => {
                to_value(&next, REDUCER_RESULT).map_err(|error| error.message().to_string())
            }
            Err(error) => Err(
                callback_error(py, &error, ErrorCode::CONFIG_INVALID, "The reducer")
                    .message()
                    .to_string(),
            ),
        }
    })
    .unwrap_or_else(|| {
        Err(
            "The reducer is unavailable because the Python interpreter is shutting down"
                .to_string(),
        )
    })
}

fn first_value(functions: &ReducerFunctions) -> Value {
    let started = call_python(
        ErrorCode::CONFIG_INVALID,
        "The initialValue function",
        Reentry::Allowed,
        |py| {
            let initial = functions.initial.bind(py).call0()?;
            Ok(to_value(&initial, REDUCER_RESULT)?)
        },
    );
    match started {
        Ok(value) => value,
        Err(error) => std::panic::resume_unwind(Box::new(error.message().to_string())),
    }
}

fn reducer_of((reducer, initial): FunctionPair) -> GroupReducer {
    let functions = Arc::new(ReducerFunctions { reducer, initial });
    let folding = Arc::clone(&functions);
    let starting = Arc::clone(&functions);
    let group = GroupReducer {
        reducer: Arc::new(move |accumulator: Value, document, score| {
            fold(&folding, accumulator, document, score)
        }),
        initial_value: Arc::new(move || first_value(&starting)),
    };
    let mut sources = reducer_sources();
    sources.retain(|_, source| source.strong_count() > 0);
    sources.insert(source_key(&group), Arc::downgrade(&functions));
    group
}

pub(crate) fn group_reducer(
    value: &Bound<'_, PyAny>,
    label: &str,
) -> Result<GroupReducer, NarsilError> {
    if let Ok(handle) = value.cast::<GroupReducerHandle>() {
        let functions = handle.get().held(value.py()).ok_or_else(|| {
            config_invalid(format!(
                "{label} holds a reducer handle that the garbage collector has cleared"
            ))
        })?;
        return Ok(reducer_of(functions));
    }
    let mut fields = Fields::of(value, label)?;
    let reducer = reducer_function(&mut fields, "reducer")?;
    let initial = reducer_function(&mut fields, "initialValue")?;
    fields.finish()?;
    Ok(reducer_of((reducer, initial)))
}
