use std::sync::Arc;

use narsil::{Narsil, NarsilError};

use super::constants::PREPARING_RETRY_AFTER_SECONDS;
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

const CONFIG_INVALID: &str = "CONFIG_INVALID";

pub(crate) fn preparing(failure: ServerError, preparing_code: &str) -> ServerError {
    if failure.code != preparing_code {
        return failure;
    }
    failure.with_header("retry-after", PREPARING_RETRY_AFTER_SECONDS.to_string())
}

pub(crate) fn config_invalid(message: impl Into<String>) -> ServerError {
    ServerError::coded(CONFIG_INVALID, message)
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
