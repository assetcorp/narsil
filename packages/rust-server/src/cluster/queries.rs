use narsil::QueryParams;
use narsil_cluster::node::ClusterNode;

use super::served_error;
use crate::errors::{Outcome, ServerError};
use crate::handlers::search::{object_body, regex_check, unknown_key_of};
use crate::http::pipeline::RouteContext;
use crate::http::respond::{HttpResponse, json};
use crate::http::routes::Route;
use crate::search::{
    Converted, answer_reply, default_list_limit, list_answer, list_params, preflight_value,
    query_answer, query_params, shaped_query, suggest_params, suggest_value, validate_list,
    validate_query, validate_suggest, with_server_query_limits,
};
use crate::settings::provoked_refusal;
use crate::state::ServerState;

async fn checked_after_lookup<T>(
    node: &ClusterNode,
    index: &str,
    converted: Converted<T>,
) -> Outcome<T> {
    match converted {
        Ok(value) => Ok(value),
        Err(failure) => {
            node.count_documents(index).await.map_err(served_error)?;
            Err(failure)
        }
    }
}

async fn run_query(
    node: &ClusterNode,
    index: &str,
    query: &QueryParams,
    preflight: bool,
) -> Outcome<HttpResponse> {
    if preflight {
        let result = node.preflight(index, query).await.map_err(served_error)?;
        return Ok(json(200, &preflight_value(result)));
    }
    let result = node.query(index, query).await.map_err(served_error)?;
    Ok(answer_reply(query_answer(result)).into_response())
}

async fn search(
    state: &ServerState,
    node: &ClusterNode,
    context: &RouteContext,
    preflight: bool,
) -> Outcome<HttpResponse> {
    let params = shaped_query(object_body(context)?)?;
    validate_query(&params, &state.limits)?;
    regex_check(state, &params)?;
    let mut params = with_server_query_limits(params, &state.limits);
    if preflight {
        params.remove("pinned");
        params.remove("rerank");
    }
    let index = context.param(0);
    let converted = query_params(&params, state.engine.max_rerank_window());
    let query = checked_after_lookup(node, index, converted).await?;
    let Some(unknown) = unknown_key_of(&params, &query) else {
        return run_query(node, index, &query, preflight).await;
    };
    let (bm25, failure) = unknown.into_parts();
    let sentinel = QueryParams {
        bm25: Some(bm25),
        ..query
    };
    Err(match run_query(node, index, &sentinel, preflight).await {
        Err(raised) if !provoked_refusal(&raised) => raised,
        _ => failure,
    })
}

async fn suggest(node: &ClusterNode, context: &RouteContext) -> Outcome<HttpResponse> {
    let params = object_body(context)?;
    validate_suggest(&params)?;
    let suggestion = suggest_params(&params);
    let result = node
        .suggest(context.param(0), &suggestion)
        .await
        .map_err(served_error)?;
    Ok(json(200, &suggest_value(result)))
}

async fn list(
    state: &ServerState,
    node: &ClusterNode,
    context: &RouteContext,
) -> Outcome<HttpResponse> {
    let params = object_body(context)?;
    validate_list(&params, state.limits.max_fetch_documents)?;
    regex_check(state, &params)?;
    let index = context.param(0);
    let listing = list_params(&params, default_list_limit(&state.limits));
    let listing = checked_after_lookup(node, index, listing).await?;
    let result = node
        .list_documents_sorted(index, &listing.params, &listing.sort)
        .await
        .map_err(served_error)?;
    Ok(answer_reply(list_answer(result)).into_response())
}

pub(super) async fn handle(
    state: &ServerState,
    node: &ClusterNode,
    route: Route,
    context: &RouteContext,
) -> Outcome<HttpResponse> {
    match route {
        Route::Search => search(state, node, context, false).await,
        Route::Preflight => search(state, node, context, true).await,
        Route::Suggest => suggest(node, context).await,
        Route::List => list(state, node, context).await,
        _ => Err(ServerError::internal()),
    }
}
