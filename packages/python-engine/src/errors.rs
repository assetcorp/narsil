use narsil::{ErrorCode, NarsilError};
use pyo3::prelude::*;
use pyo3::types::PyString;

mod python {
    pyo3::import_exception!(narsil._errors, NarsilError);
}

pub(crate) use python::NarsilError as PyNarsilError;

pub(crate) fn to_py_err(error: NarsilError) -> PyErr {
    PyNarsilError::new_err((error.code().as_str(), error.message().to_string()))
}

pub(crate) fn invalid(code: ErrorCode, message: impl Into<String>) -> NarsilError {
    NarsilError::new(code, message)
}

pub(crate) fn config_invalid(message: impl Into<String>) -> NarsilError {
    NarsilError::new(ErrorCode::CONFIG_INVALID, message)
}

pub(crate) fn recoded(code: ErrorCode) -> impl Fn(NarsilError) -> NarsilError {
    move |error| NarsilError::new(code, error.message())
}

fn exception_text(py: Python<'_>, error: &PyErr) -> String {
    let kind = error
        .get_type(py)
        .name()
        .map(|name| name.to_string())
        .unwrap_or_else(|_| "Exception".to_string());
    match error.value(py).str() {
        Ok(text) if !text.to_string_lossy().is_empty() => {
            format!("{kind}: {}", text.to_string_lossy())
        }
        _ => kind,
    }
}

fn raised_narsil_error(py: Python<'_>, error: &PyErr) -> Option<NarsilError> {
    if !error.is_instance_of::<PyNarsilError>(py) {
        return None;
    }
    let value = error.value(py);
    let code = value.getattr("code").ok()?;
    let code = code.cast::<PyString>().ok()?.to_string_lossy().into_owned();
    let message = value
        .getattr("message")
        .ok()
        .and_then(|message| message.str().ok())
        .map(|message| message.to_string_lossy().into_owned())
        .unwrap_or_default();
    ErrorCode::from_name(&code).map(|code| NarsilError::new(code, message))
}

pub(crate) fn callback_error(
    py: Python<'_>,
    error: &PyErr,
    code: ErrorCode,
    subject: &str,
) -> NarsilError {
    if let Some(raised) = raised_narsil_error(py, error) {
        return raised;
    }
    NarsilError::new(
        code,
        format!("{subject} raised {}", exception_text(py, error)),
    )
}

pub(crate) fn interpreter_finalizing(code: ErrorCode, subject: &str) -> NarsilError {
    NarsilError::new(
        code,
        format!("{subject} is unavailable because the Python interpreter is shutting down"),
    )
}
