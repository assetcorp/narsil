use narsil::{Map, Narsil, QueryParams, Value};

use super::common::json_object_body;
use crate::errors::{Outcome, ServerError};
use crate::http::pipeline::RouteContext;
use crate::http::respond::json;
use crate::http::routes::Route;
use crate::search::{
    Converted, Reply, answer_reply, default_list_limit, list_answer, list_params, preflight_value,
    query_answer, query_params, refused_regex, shaped_query, suggest_params, suggest_value,
    validate_list, validate_query, validate_suggest, with_server_query_limits,
};
use crate::settings::{UnknownBm25Key, unknown_bm25_key};
use crate::state::ServerState;

fn checked_after_lookup<T>(engine: &Narsil, index: &str, converted: Converted<T>) -> Outcome<T> {
    match converted {
        Ok(value) => Ok(value),
        Err(failure) => {
            engine.count_documents(index).map_err(ServerError::from)?;
            Err(failure)
        }
    }
}

pub(crate) fn object_body(context: &RouteContext) -> Outcome<Map> {
    match json_object_body(context)? {
        Value::Object(params) => Ok(params),
        _ => Err(ServerError::internal()),
    }
}

pub(crate) fn regex_check(state: &ServerState, params: &Map) -> Outcome<()> {
    match refused_regex(params.get("filters"), state.allow_regex) {
        Some(refusal) => Err(refusal),
        None => Ok(()),
    }
}

pub(crate) fn unknown_key_of(params: &Map, query: &QueryParams) -> Option<UnknownBm25Key> {
    match (params.get("bm25"), &query.bm25) {
        (Some(Value::Object(raw)), Some(bm25)) => unknown_bm25_key(raw, bm25),
        _ => None,
    }
}

fn search(state: &ServerState, context: &RouteContext, preflight: bool) -> Outcome<Reply> {
    let params = shaped_query(object_body(context)?)?;
    validate_query(&params, &state.limits)?;
    regex_check(state, &params)?;
    let mut params = with_server_query_limits(params, &state.limits);
    if preflight {
        params.remove("pinned");
        params.remove("rerank");
    }
    let index = context.param(0);
    let engine = state.engine.as_ref();
    let query = checked_after_lookup(
        engine,
        index,
        query_params(&params, engine.max_rerank_window()),
    )?;
    if let Some(unknown) = unknown_key_of(&params, &query) {
        return Err(unknown.refusal(engine, |engine, bm25| {
            let sentinel = QueryParams {
                bm25: Some(bm25),
                ..query
            };
            if preflight {
                engine.preflight(index, &sentinel).map(drop)
            } else {
                engine.query(index, &sentinel).map(drop)
            }
        }));
    }
    if preflight {
        let result = engine.preflight(index, &query).map_err(ServerError::from)?;
        return Ok(Reply::Ready(json(200, &preflight_value(result))));
    }
    let result = engine.query(index, &query).map_err(ServerError::from)?;
    Ok(answer_reply(query_answer(result)))
}

fn suggest(state: &ServerState, context: &RouteContext) -> Outcome<Reply> {
    let params = object_body(context)?;
    validate_suggest(&params)?;
    let suggestion = suggest_params(&params);
    let result = state
        .engine
        .suggest(context.param(0), &suggestion)
        .map_err(ServerError::from)?;
    Ok(Reply::Ready(json(200, &suggest_value(result))))
}

fn list(state: &ServerState, context: &RouteContext) -> Outcome<Reply> {
    let params = object_body(context)?;
    validate_list(&params, state.limits.max_fetch_documents)?;
    regex_check(state, &params)?;
    let index = context.param(0);
    let engine = state.engine.as_ref();
    let listing = list_params(&params, default_list_limit(&state.limits));
    let listing = checked_after_lookup(engine, index, listing)?;
    let result = engine
        .list_documents_sorted(index, &listing.params, &listing.sort)
        .map_err(ServerError::from)?;
    Ok(answer_reply(list_answer(result)))
}

pub(crate) fn answer(state: &ServerState, route: Route, context: &RouteContext) -> Outcome<Reply> {
    match route {
        Route::Search => search(state, context, false),
        Route::Preflight => search(state, context, true),
        Route::Suggest => suggest(state, context),
        Route::List => list(state, context),
        _ => Err(ServerError::internal()),
    }
}
