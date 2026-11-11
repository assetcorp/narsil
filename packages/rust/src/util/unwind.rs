use std::any::Any;
use std::panic::{AssertUnwindSafe, catch_unwind};

use crate::error::{ErrorCode, NarsilError, Result};

/// Returns the text that a panic carried, or `None` where its payload holds no text.
pub(crate) fn panic_text(payload: &(dyn Any + Send)) -> Option<String> {
    if let Some(text) = payload.downcast_ref::<&str>() {
        return Some((*text).to_string());
    }
    if let Some(text) = payload.downcast_ref::<String>() {
        return Some(text.clone());
    }
    payload
        .downcast_ref::<NarsilError>()
        .map(|error| error.message().to_string())
}

/// Turns the payload of a panic inside caller code into an error: a [`NarsilError`] payload passes unchanged, and
/// any other payload raises `code` with a message that names `subject` and holds the text that the panic carried.
pub(crate) fn unwound_error(
    payload: Box<dyn Any + Send>,
    code: ErrorCode,
    subject: &str,
) -> NarsilError {
    match payload.downcast::<NarsilError>() {
        Ok(raised) => *raised,
        Err(payload) => match panic_text(payload.as_ref()) {
            Some(text) => NarsilError::new(code, format!("{subject} failed: {text}")),
            None => NarsilError::new(code, format!("{subject} panicked")),
        },
    }
}

/// Runs caller code, such as a tokenizer or a stop word function, and returns the error that [`unwound_error`]
/// builds where that code panics, so that the panic leaves the engine as it was.
pub(crate) fn guarded<T>(code: ErrorCode, subject: &str, call: impl FnOnce() -> T) -> Result<T> {
    catch_unwind(AssertUnwindSafe(call)).map_err(|payload| unwound_error(payload, code, subject))
}
