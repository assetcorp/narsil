use std::sync::Arc;

use narsil::{Map, Narsil, Value, parse_plain_json};

use crate::errors::{Outcome, ServerError, server_codes};
use crate::http::pipeline::RouteContext;
use crate::state::ServerState;

fn parse_text(raw: &[u8]) -> Outcome<Value> {
    let text = String::from_utf8_lossy(raw);
    parse_plain_json(&text).map_err(|_| {
        ServerError::new(
            400,
            server_codes::INVALID_JSON,
            "Request body is not valid JSON",
        )
    })
}

pub(crate) fn json_body(context: &RouteContext) -> Outcome<Value> {
    match context.body.as_deref() {
        None | Some([]) => Err(ServerError::new(
            400,
            server_codes::EMPTY_BODY,
            "Request body is empty",
        )),
        Some(raw) => parse_text(raw),
    }
}

pub(crate) fn optional_json_body(context: &RouteContext) -> Outcome<Value> {
    match context.body.as_deref() {
        None | Some([]) => Ok(Value::Object(Map::new())),
        Some(raw) => match parse_text(raw)? {
            Value::Object(fields) => Ok(Value::Object(fields)),
            _ => Err(ServerError::invalid("The request body must be an object")),
        },
    }
}

pub(crate) async fn engine_call<T, F>(state: &Arc<ServerState>, work: F) -> Outcome<T>
where
    T: Send + 'static,
    F: FnOnce(&Narsil) -> narsil::Result<T> + Send + 'static,
{
    let engine = Arc::clone(&state.engine);
    match tokio::task::spawn_blocking(move || work(&engine)).await {
        Ok(outcome) => outcome.map_err(ServerError::from),
        Err(_) => Err(ServerError::internal()),
    }
}

pub(crate) fn object(entries: Vec<(&str, Value)>) -> Value {
    let mut map = Map::with_capacity(entries.len());
    for (key, value) in entries {
        map.insert(key, value);
    }
    Value::Object(map)
}
