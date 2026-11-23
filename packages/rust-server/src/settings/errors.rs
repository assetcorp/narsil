use std::sync::Arc;

use narsil::{Narsil, NarsilError, Value};

use super::constants::{MILLISECONDS_PER_SECOND, PREPARING_RETRY_AFTER_SECONDS};
use crate::errors::{Outcome, ServerError};
use crate::state::ServerState;

pub(crate) async fn on_engine<T, F>(state: &Arc<ServerState>, work: F) -> Outcome<T>
where
    T: Send + 'static,
    F: FnOnce(&Narsil) -> Outcome<T> + Send + 'static,
{
    let engine = Arc::clone(&state.engine);
    tokio::task::spawn_blocking(move || work(&engine))
        .await
        .unwrap_or_else(|_| Err(ServerError::internal()))
}

pub(crate) fn preparing(failure: ServerError, preparing_code: &str) -> ServerError {
    if failure.code != preparing_code {
        return failure;
    }
    let retry_after_ms = failure
        .details
        .as_ref()
        .and_then(|details| details.get("retryAfterMs"))
        .and_then(Value::as_f64)
        .filter(|milliseconds| milliseconds.is_finite() && *milliseconds > 0.0);
    let seconds = retry_after_ms.map_or(PREPARING_RETRY_AFTER_SECONDS, |milliseconds| {
        (milliseconds / MILLISECONDS_PER_SECOND).ceil() as u64
    });
    failure.with_header("retry-after", seconds.to_string())
}

pub(crate) fn after_engine_checks<T>(
    engine: &Narsil,
    failure: ServerError,
    provoke: impl FnOnce(&Narsil) -> narsil::Result<T>,
    provoked: impl Fn(&NarsilError) -> bool,
) -> ServerError {
    match provoke(engine) {
        Err(raised) if !provoked(&raised) => ServerError::from(raised),
        _ => failure,
    }
}
