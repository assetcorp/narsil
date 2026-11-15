use std::sync::Arc;

use narsil::{Map, Value};

use super::common::{engine_call, json_object_body};
use crate::errors::{Outcome, ServerError};
use crate::http::pipeline::RouteContext;
use crate::http::respond::{HttpResponse, json};
use crate::http::routes::Route;
use crate::search::{
    Converted, default_list_limit, list_answer, list_params, preflight_value, query_answer,
    query_params, refused_regex, respond_answer, shaped_query, suggest_params, suggest_value,
    validate_list, validate_query, validate_suggest, with_server_query_limits,
};
use crate::state::ServerState;

async fn checked_after_lookup<T>(
    state: &Arc<ServerState>,
    index: &str,
    converted: Converted<T>,
) -> Outcome<T> {
    match converted {
        Ok(value) => Ok(value),
        Err(failure) => {
            let index = index.to_string();
            engine_call(state, move |engine| engine.count_documents(&index)).await?;
            Err(failure)
        }
    }
}

fn object_body(context: &RouteContext) -> Outcome<Map> {
    match json_object_body(context)? {
        Value::Object(params) => Ok(params),
        _ => Err(ServerError::internal()),
    }
}

fn regex_check(state: &ServerState, params: &Map) -> Outcome<()> {
    match refused_regex(params.get("filters"), state.allow_regex) {
        Some(refusal) => Err(refusal),
        None => Ok(()),
    }
}

async fn search(
    state: Arc<ServerState>,
    context: RouteContext,
    preflight: bool,
) -> Outcome<HttpResponse> {
    let params = shaped_query(object_body(&context)?)?;
    validate_query(&params, &state.limits)?;
    regex_check(&state, &params)?;
    let mut params = with_server_query_limits(params, &state.limits);
    if preflight {
        params.remove("pinned");
        params.remove("rerank");
    }
    let index = context.param(0).to_string();
    let max_rerank_window = state.engine.max_rerank_window();
    let query =
        checked_after_lookup(&state, &index, query_params(&params, max_rerank_window)).await?;
    if preflight {
        let result = engine_call(&state, move |engine| engine.preflight(&index, &query)).await?;
        return Ok(json(200, &preflight_value(result)));
    }
    let result = engine_call(&state, move |engine| engine.query(&index, &query)).await?;
    Ok(respond_answer(query_answer(result)))
}

async fn suggest(state: Arc<ServerState>, context: RouteContext) -> Outcome<HttpResponse> {
    let params = object_body(&context)?;
    validate_suggest(&params)?;
    let index = context.param(0).to_string();
    let suggestion = suggest_params(&params);
    let result = engine_call(&state, move |engine| engine.suggest(&index, &suggestion)).await?;
    Ok(json(200, &suggest_value(result)))
}

async fn list(state: Arc<ServerState>, context: RouteContext) -> Outcome<HttpResponse> {
    let params = object_body(&context)?;
    validate_list(&params, state.limits.max_fetch_documents)?;
    regex_check(&state, &params)?;
    let index = context.param(0).to_string();
    let listing = list_params(&params, default_list_limit(&state.limits));
    let listing = checked_after_lookup(&state, &index, listing).await?;
    let result = engine_call(&state, move |engine| {
        engine.list_documents_sorted(&index, &listing.params, &listing.sort)
    })
    .await?;
    Ok(respond_answer(list_answer(result)))
}

pub(crate) async fn handle(
    state: Arc<ServerState>,
    route: Route,
    context: RouteContext,
) -> Outcome<HttpResponse> {
    match route {
        Route::Search => search(state, context, false).await,
        Route::Preflight => search(state, context, true).await,
        Route::Suggest => suggest(state, context).await,
        Route::List => list(state, context).await,
        _ => Err(ServerError::internal()),
    }
}
