use std::sync::Arc;

use narsil::{Map, Value};

use crate::errors::{Outcome, ServerError, server_codes};
use crate::http::pipeline::RouteContext;
use crate::http::respond::{HttpResponse, json};
use crate::http::routes::Route;
use crate::state::ServerState;
use crate::tasks::{CancelOutcome, parse_task_list_query};

fn task_not_found(id: &str) -> ServerError {
    ServerError::new(
        404,
        server_codes::TASK_NOT_FOUND,
        format!("Task \"{id}\" not found"),
    )
}

async fn list_tasks(state: &ServerState, context: &RouteContext) -> Outcome<HttpResponse> {
    let query = parse_task_list_query(
        |name| context.query_value(name).map(str::to_string),
        state.limits.max_task_page_size,
    )?;
    let page = state
        .tasks
        .list(&query)
        .await
        .map_err(|_| ServerError::internal())?;
    Ok(json(200, &page.to_wire()))
}

async fn get_task(state: &ServerState, context: &RouteContext) -> Outcome<HttpResponse> {
    let id = context.param(0);
    match state.tasks.get(id).await {
        Ok(Some(record)) => Ok(json(200, &record.to_wire())),
        Ok(None) => Err(task_not_found(id)),
        Err(_) => Err(ServerError::internal()),
    }
}

async fn cancel_task(state: &ServerState, context: &RouteContext) -> Outcome<HttpResponse> {
    let id = context.param(0);
    let outcome = state
        .tasks
        .cancel(id)
        .await
        .map_err(|_| ServerError::internal())?;
    match outcome {
        CancelOutcome::Cancelling(record) => Ok(json(202, &record.to_wire())),
        CancelOutcome::NotFound => Err(task_not_found(id)),
        CancelOutcome::AlreadyFinished(status) => {
            let mut details = Map::new();
            details.insert("status", Value::String(status.as_str().to_string()));
            Err(ServerError::new(
                409,
                server_codes::TASK_NOT_CANCELLABLE,
                format!("Task \"{id}\" has already finished"),
            )
            .with_details(details))
        }
        CancelOutcome::OwnedByAnotherInstance(owner) => {
            let mut details = Map::new();
            details.insert("owner", Value::String(owner));
            Err(ServerError::new(
                409,
                server_codes::TASK_OWNED_BY_ANOTHER_INSTANCE,
                format!(
                    "Task \"{id}\" runs on another server instance, which is the only one that can stop it"
                ),
            )
            .with_details(details))
        }
    }
}

pub(crate) async fn handle(
    state: Arc<ServerState>,
    route: Route,
    context: RouteContext,
) -> Outcome<HttpResponse> {
    match route {
        Route::ListTasks => list_tasks(&state, &context).await,
        Route::GetTask => get_task(&state, &context).await,
        _ => cancel_task(&state, &context).await,
    }
}
