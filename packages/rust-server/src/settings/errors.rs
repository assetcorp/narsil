use std::sync::Arc;

use narsil::{Narsil, NarsilError, Value};

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

const INDEX_NOT_FOUND: &str = "INDEX_NOT_FOUND";
const CONFIG_INVALID: &str = "CONFIG_INVALID";

const INDEX_NAMED_FAILURES: [(&str, &str); 5] = [
    (INDEX_NOT_FOUND, "does not exist"),
    ("SYNC_NOT_ENABLED", "has device sync off"),
    (
        "SYNC_DURABILITY_REQUIRED",
        "needs write-ahead log durability for device sync, because the feed reads the log",
    ),
    (
        "CHANGES_DURABILITY_REQUIRED",
        "needs write-ahead log durability for change capture, because the feed reads the log",
    ),
    (
        CONFIG_INVALID,
        "has popular query suggestions on, so it cannot sync to devices: a device receives the whole index of one user, while a suggestion comes from the searches of several people",
    ),
];

fn names_the_index(failure: &ServerError, index_name: &str) -> bool {
    let Some(rest) = failure
        .message
        .strip_prefix("Index \"")
        .and_then(|rest| rest.strip_prefix(index_name))
        .and_then(|rest| rest.strip_prefix("\" "))
    else {
        return false;
    };
    INDEX_NAMED_FAILURES
        .iter()
        .any(|(code, tail)| failure.code == *code && rest == *tail)
}

pub(crate) fn indexed(failure: ServerError, index_name: &str) -> ServerError {
    if failure.details.is_none() && names_the_index(&failure, index_name) {
        return failure.with_detail("indexName", Value::String(index_name.to_string()));
    }
    failure
}

pub(crate) fn engine_failure(index_name: &str) -> impl Fn(NarsilError) -> ServerError + '_ {
    move |raised| indexed(ServerError::from(raised), index_name)
}

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
    index_name: &str,
    failure: ServerError,
    provoke: impl FnOnce(&Narsil) -> narsil::Result<T>,
    provoked: impl Fn(&NarsilError) -> bool,
) -> ServerError {
    match provoke(engine) {
        Err(raised) if !provoked(&raised) => indexed(ServerError::from(raised), index_name),
        _ => failure,
    }
}
