use std::sync::Arc;

use narsil::{ErrorCode, Map, QuerySuggestionsBuild, QuerySuggestionsBuildStatus, Value};

use super::{accepted, coded, on_blocking_pool};
use crate::errors::{Outcome, ServerError};
use crate::handlers::common::engine_call;
use crate::http::pipeline::RouteContext;
use crate::http::respond::HttpResponse;
use crate::state::ServerState;
use crate::tasks::{TaskContext, TaskFailure, TaskLaunch, TaskOperation};

fn optional_number(value: Option<u64>) -> Value {
    value.map_or(Value::Null, |number| Value::Number(number as f64))
}

pub(crate) fn build_of(build: &QuerySuggestionsBuild) -> Map {
    let mut out = Map::new();
    out.insert("buildId", Value::String(build.build_id.clone()));
    out.insert("trigger", Value::String(build.trigger.as_str().to_string()));
    out.insert("status", Value::String(build.status.as_str().to_string()));
    out.insert("startedAt", Value::Number(build.started_at as f64));
    out.insert("endedAt", optional_number(build.ended_at));
    out.insert("published", Value::Number(build.published as f64));
    out.insert("removed", Value::Number(build.removed as f64));
    out.insert("discarded", Value::Number(build.discarded as f64));
    out.insert(
        "errorCode",
        build.error_code.clone().map_or(Value::Null, Value::String),
    );
    out
}

pub(crate) fn failed_build(index: &str, build: &QuerySuggestionsBuild) -> TaskFailure {
    let code = build
        .error_code
        .as_deref()
        .unwrap_or(ErrorCode::WORKER_ACTION_FAILED.as_str());
    let mut details = Map::new();
    details.insert("indexName", Value::String(index.to_string()));
    details.insert("buildId", Value::String(build.build_id.clone()));
    TaskFailure::Coded(
        ServerError::coded(code, "The build of popular query suggestions failed")
            .with_details(details),
    )
}

fn build_task(state: &ServerState, index: String) -> TaskOperation {
    let engine = Arc::clone(&state.engine);
    Box::new(move |context: TaskContext| {
        Box::pin(on_blocking_pool(move || {
            let finished = engine.query_suggestions().build(&index).map_err(coded)?;
            context.report_build(build_of(&finished));
            if finished.status == QuerySuggestionsBuildStatus::Failed {
                return Err(failed_build(&index, &finished));
            }
            Ok(())
        }))
    })
}

pub(crate) fn suggestions_off(index: &str) -> ServerError {
    ServerError::coded(
        ErrorCode::QUERY_SUGGESTIONS_NOT_ENABLED.as_str(),
        format!("Index \"{index}\" has popular query suggestions off"),
    )
    .with_detail("indexName", Value::String(index.to_string()))
}

pub(crate) async fn build_query_suggestions(
    state: Arc<ServerState>,
    context: RouteContext,
) -> Outcome<HttpResponse> {
    let index = context.param(0).to_string();
    let named = index.clone();
    let status = engine_call(&state, move |engine| {
        engine.query_suggestions().status(&named)
    })
    .await?;
    if !status.setting.is_some_and(|setting| setting.enabled) {
        return Err(suggestions_off(&index));
    }
    let operation = build_task(&state, index.clone());
    accepted(
        &state,
        TaskLaunch::on("querySuggestionsBuild", &index),
        operation,
    )
    .await
}
