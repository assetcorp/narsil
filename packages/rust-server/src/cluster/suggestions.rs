use std::sync::Arc;

use narsil::{QuerySuggestionsBuildStatus, QuerySuggestionsSetting, Value};
use narsil_cluster::node::ClusterNode;

use super::served_error;
use crate::errors::{Outcome, ServerError};
use crate::handlers::common::{json_body, object};
use crate::handlers::suggestions::{
    ban_list, body_object, manual_suggestion, ok, phrase_of, preview_limit, recorded_query,
    unidentified,
};
use crate::http::pipeline::RouteContext;
use crate::http::respond::{HttpResponse, json};
use crate::http::routes::Route;
use crate::maintenance::{accepted, build_of, failed_build, suggestions_off};
use crate::search::{bans_value, preview_value, recorded_value, status_value};
use crate::state::ServerState;
use crate::tasks::{TaskFailure, TaskLaunch, TaskOperation};

async fn update(node: &ClusterNode, context: &RouteContext) -> Outcome<HttpResponse> {
    let setting = QuerySuggestionsSetting::from_input(&json_body(context)?)?;
    node.query_suggestions()
        .update_setting(context.param(0), &setting)
        .await
        .map_err(served_error)?;
    Ok(ok())
}

async fn status(node: &ClusterNode, context: &RouteContext) -> Outcome<HttpResponse> {
    let status = node
        .query_suggestions()
        .status(context.param(0))
        .await
        .map_err(served_error)?;
    Ok(json(200, &status_value(status)))
}

async fn record(
    state: &ServerState,
    node: &ClusterNode,
    context: RouteContext,
) -> Outcome<HttpResponse> {
    let index = context.param(0).to_string();
    let Some(recorded) = recorded_query(state, context).await? else {
        return Ok(unidentified());
    };
    let result = node
        .query_suggestions()
        .record_query(&index, &recorded)
        .await
        .map_err(served_error)?;
    Ok(json(200, &recorded_value(result)))
}

async fn build(
    state: &ServerState,
    node: Arc<ClusterNode>,
    context: &RouteContext,
) -> Outcome<HttpResponse> {
    let index = context.param(0).to_string();
    let status = node
        .query_suggestions()
        .status(&index)
        .await
        .map_err(served_error)?;
    if !status.setting.is_some_and(|setting| setting.enabled) {
        return Err(suggestions_off(&index));
    }
    let named = index.clone();
    let operation: TaskOperation = Box::new(move |task| {
        Box::pin(async move {
            let finished = node
                .query_suggestions()
                .build(&named)
                .await
                .map_err(|error| TaskFailure::Coded(served_error(error)))?;
            task.report_build(build_of(&finished));
            if finished.status == QuerySuggestionsBuildStatus::Failed {
                return Err(failed_build(&named, &finished));
            }
            Ok(())
        })
    });
    accepted(
        state,
        TaskLaunch::on("querySuggestionsBuild", &index),
        operation,
    )
    .await
}

async fn preview(node: &ClusterNode, context: &RouteContext) -> Outcome<HttpResponse> {
    let limit = preview_limit(context)?;
    let preview = node
        .query_suggestions()
        .preview(context.param(0), limit)
        .await
        .map_err(served_error)?;
    Ok(json(200, &preview_value(preview)))
}

async fn read_bans(node: &ClusterNode, context: &RouteContext) -> Outcome<HttpResponse> {
    let bans = node
        .query_suggestions()
        .bans(context.param(0))
        .await
        .map_err(served_error)?;
    Ok(json(200, &bans_value(bans)))
}

async fn replace_bans(node: &ClusterNode, context: &RouteContext) -> Outcome<HttpResponse> {
    let phrases = ban_list(&body_object(context)?)?;
    let bans = node
        .query_suggestions()
        .update_bans(context.param(0), &phrases)
        .await
        .map_err(served_error)?;
    Ok(json(200, &bans_value(bans)))
}

async fn remove(node: &ClusterNode, context: &RouteContext) -> Outcome<HttpResponse> {
    let query = phrase_of(&body_object(context)?)?;
    let held = node
        .query_suggestions()
        .remove_query(context.param(0), &query)
        .await
        .map_err(served_error)?;
    Ok(json(
        200,
        &object(vec![("suggestionIndexes", Value::Number(held as f64))]),
    ))
}

async fn manual(node: &ClusterNode, context: &RouteContext) -> Outcome<HttpResponse> {
    let suggestion = manual_suggestion(&body_object(context)?)?;
    let name = node
        .query_suggestions()
        .add_suggestion(context.param(0), &suggestion)
        .await
        .map_err(served_error)?;
    Ok(json(200, &object(vec![("indexName", Value::String(name))])))
}

pub(super) async fn handle(
    state: &ServerState,
    node: Arc<ClusterNode>,
    route: Route,
    context: RouteContext,
) -> Outcome<HttpResponse> {
    match route {
        Route::UpdateQuerySuggestions => update(&node, &context).await,
        Route::QuerySuggestionsStatus => status(&node, &context).await,
        Route::RecordQuery => record(state, &node, context).await,
        Route::BuildQuerySuggestions => build(state, node, &context).await,
        Route::PreviewQuerySuggestions => preview(&node, &context).await,
        Route::ReadQueryBans => read_bans(&node, &context).await,
        Route::ReplaceQueryBans => replace_bans(&node, &context).await,
        Route::RemoveQuery => remove(&node, &context).await,
        Route::AddManualSuggestion => manual(&node, &context).await,
        _ => Err(ServerError::internal()),
    }
}
