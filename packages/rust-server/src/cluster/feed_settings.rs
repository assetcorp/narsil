use narsil_cluster::node::ClusterNode;

use super::served_error;
use crate::errors::{Outcome, ServerError};
use crate::handlers::common::json_body;
use crate::http::pipeline::RouteContext;
use crate::http::respond::{HttpResponse, json};
use crate::http::routes::Route;
use crate::settings::{
    changes_setting_of, changes_status_json, ok, sync_setting_of, sync_status_json,
};

async fn update_sync(node: &ClusterNode, context: &RouteContext) -> Outcome<HttpResponse> {
    let body = json_body(context)?;
    let name = context.param(0);
    node.get_sync(name).await.map_err(served_error)?;
    let setting = sync_setting_of(&body)?;
    node.update_sync(name, &setting)
        .await
        .map_err(served_error)?;
    Ok(ok())
}

async fn update_changes(node: &ClusterNode, context: &RouteContext) -> Outcome<HttpResponse> {
    let body = json_body(context)?;
    let name = context.param(0);
    node.get_changes(name).await.map_err(served_error)?;
    let setting = changes_setting_of(&body)?;
    node.update_changes(name, &setting)
        .await
        .map_err(served_error)?;
    Ok(ok())
}

pub(super) async fn handle(
    node: &ClusterNode,
    route: Route,
    context: &RouteContext,
) -> Outcome<HttpResponse> {
    let name = context.param(0);
    match route {
        Route::GetSync => {
            let status = node.get_sync(name).await.map_err(served_error)?;
            Ok(json(200, &sync_status_json(status)))
        }
        Route::UpdateSync => update_sync(node, context).await,
        Route::GetChanges => {
            let status = node.get_changes(name).await.map_err(served_error)?;
            Ok(json(200, &changes_status_json(status)))
        }
        Route::UpdateChanges => update_changes(node, context).await,
        _ => Err(ServerError::internal()),
    }
}
