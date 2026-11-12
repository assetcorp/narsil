use std::any::Any;
use std::panic::{AssertUnwindSafe, catch_unwind};

use crate::error::{ErrorCode, NarsilError, Result};

/// Returns the text in the payload of a panic, or `None` when the payload holds no text.
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

/// Converts the payload of a panic inside caller code into an error. A [`NarsilError`] payload comes back
/// unchanged, and any other payload becomes an error with `code` and a message that holds `subject` and the text
/// of the panic.
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

/// Calls caller code, such as a tokenizer or a stop word function, and returns the error that [`unwound_error`]
/// builds when that code panics, so that a panic leaves the state of the engine unchanged.
pub(crate) fn guarded<T>(code: ErrorCode, subject: &str, call: impl FnOnce() -> T) -> Result<T> {
    catch_unwind(AssertUnwindSafe(call)).map_err(|payload| unwound_error(payload, code, subject))
}
