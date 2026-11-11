pub(crate) mod adapters;
pub(crate) mod analysis;
pub(crate) mod functions;
pub(crate) mod persistence;
pub(crate) mod plugins;
pub(crate) mod reducer;
pub(crate) mod reentry;
pub(crate) mod retained;

use narsil::{ErrorCode, NarsilError};
use pyo3::prelude::*;

use self::reentry::{Reentry, awaited};
use crate::errors::{callback_error, interpreter_finalizing};

pub(crate) fn call_python<T>(
    code: ErrorCode,
    subject: &str,
    reentry: Reentry,
    call: impl for<'py> FnOnce(Python<'py>) -> Result<T, CallbackFailure>,
) -> Result<T, NarsilError> {
    Python::try_attach(|py| {
        let _awaited = awaited(reentry, subject);
        call(py).map_err(|failure| match failure {
            CallbackFailure::Raised(error) => callback_error(py, &error, code, subject),
            CallbackFailure::Refused(error) => NarsilError::new(
                code,
                format!(
                    "{subject} returned a value that the engine cannot use: {}",
                    error.message()
                ),
            ),
            CallbackFailure::Coded(error) => error,
        })
    })
    .unwrap_or_else(|| Err(interpreter_finalizing(code, subject)))
}

pub(crate) enum CallbackFailure {
    Raised(PyErr),
    Refused(NarsilError),
    Coded(NarsilError),
}

impl From<PyErr> for CallbackFailure {
    fn from(error: PyErr) -> CallbackFailure {
        CallbackFailure::Raised(error)
    }
}

impl From<NarsilError> for CallbackFailure {
    fn from(error: NarsilError) -> CallbackFailure {
        CallbackFailure::Refused(error)
    }
}

pub(crate) fn report_unraisable(py: Python<'_>, error: PyErr, source: &Bound<'_, PyAny>) {
    error.write_unraisable(py, Some(source));
}
