use std::sync::Arc;

use super::errors::{engine_failure, on_engine};
use super::feed_settings::{
    changes_setting_of, changes_status_json, sync_setting_of, sync_status_json,
};
use super::routes::ok;
use super::sync_snapshot::sync_snapshot;
use crate::errors::{Outcome, ServerError};
use crate::handlers::common::json_body;
use crate::http::pipeline::RouteContext;
use crate::http::respond::{HttpResponse, json};
use crate::http::routes::Route;
use crate::state::ServerState;

async fn get_sync(state: &Arc<ServerState>, name: String) -> Outcome<HttpResponse> {
    let status = on_engine(state, move |engine| {
        engine.get_sync(&name).map_err(engine_failure(&name))
    })
    .await?;
    Ok(json(200, &sync_status_json(status)))
}

async fn update_sync(
    state: &Arc<ServerState>,
    context: &RouteContext,
    name: String,
) -> Outcome<HttpResponse> {
    let body = json_body(context)?;
    on_engine(state, move |engine| {
        engine.get_sync(&name).map_err(engine_failure(&name))?;
        let setting = sync_setting_of(&body)?;
        engine
            .update_sync(&name, &setting)
            .map_err(engine_failure(&name))
    })
    .await?;
    Ok(ok())
}

async fn get_changes(state: &Arc<ServerState>, name: String) -> Outcome<HttpResponse> {
    let status = on_engine(state, move |engine| {
        engine
            .get_changes_setting(&name)
            .map_err(engine_failure(&name))
    })
    .await?;
    Ok(json(200, &changes_status_json(status)))
}

async fn update_changes(
    state: &Arc<ServerState>,
    context: &RouteContext,
    name: String,
) -> Outcome<HttpResponse> {
    let body = json_body(context)?;
    on_engine(state, move |engine| {
        engine
            .get_changes_setting(&name)
            .map_err(engine_failure(&name))?;
        let setting = changes_setting_of(&body)?;
        engine
            .update_changes(&name, &setting)
            .map_err(engine_failure(&name))
    })
    .await?;
    Ok(ok())
}

pub(crate) async fn handle(
    state: Arc<ServerState>,
    route: Route,
    context: RouteContext,
) -> Outcome<HttpResponse> {
    let name = context.param(0).to_string();
    match route {
        Route::GetSync => get_sync(&state, name).await,
        Route::UpdateSync => update_sync(&state, &context, name).await,
        Route::SyncSnapshot => sync_snapshot(&state, &context).await,
        Route::GetChanges => get_changes(&state, name).await,
        Route::UpdateChanges => update_changes(&state, &context, name).await,
        _ => Err(ServerError::internal()),
    }
}
