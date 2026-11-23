mod allocation;
mod feed_settings;
mod jobs;
mod operations;
mod writes;

use std::sync::Arc;

use narsil::{Map, Value};
use narsil_cluster::error::ClusterError;
use narsil_cluster::node::{ClusterNode, NodeReadiness};

use self::operations::operation_of;
pub(crate) use self::operations::unsupported;
use crate::errors::{Outcome, ServerError};
use crate::handlers::{info, task_routes};
use crate::http::pipeline::RouteContext;
use crate::http::respond::{HttpResponse, json};
use crate::http::routes::Route;
use crate::state::ServerState;

pub(crate) fn served_error(error: ClusterError) -> ServerError {
    ServerError::coded(error.code(), error.message()).with_details(error.details().clone())
}

fn node_report(node: &ClusterNode, readiness: NodeReadiness) -> Value {
    let info = node.info();
    let mut report = Map::with_capacity(5);
    report.insert("nodeId", Value::String(info.node_id));
    report.insert(
        "roles",
        Value::Array(info.roles.into_iter().map(Value::String).collect()),
    );
    report.insert("status", Value::String(info.status.to_string()));
    report.insert("readiness", Value::String(readiness.as_str().to_string()));
    report.insert("isController", Value::Bool(node.is_controller()));
    Value::Object(report)
}

async fn readyz(state: &ServerState, node: &ClusterNode) -> Outcome<HttpResponse> {
    let readiness = node.readiness().await;
    let ready = state.is_ready() && readiness == NodeReadiness::Serving;
    let mut body = Map::with_capacity(2);
    let status = if ready { "ready" } else { "unavailable" };
    body.insert("status", Value::String(status.to_string()));
    body.insert("cluster", node_report(node, readiness));
    Ok(json(if ready { 200 } else { 503 }, &Value::Object(body)))
}

pub(crate) async fn dispatch(
    state: Arc<ServerState>,
    node: Arc<ClusterNode>,
    route: Route,
    context: RouteContext,
) -> Outcome<HttpResponse> {
    match route {
        Route::Livez => info::livez(),
        Route::Readyz => readyz(&state, &node).await,
        Route::Version => info::version(&state),
        Route::Capabilities => info::capabilities(),
        Route::ListTasks | Route::GetTask | Route::CancelTask => {
            task_routes::handle(state, route, context).await
        }
        Route::Insert | Route::Patch | Route::Remove | Route::Batch => {
            writes::handle(&state, &node, route, &context).await
        }
        Route::GetSync | Route::UpdateSync | Route::GetChanges | Route::UpdateChanges => {
            feed_settings::handle(&node, route, &context).await
        }
        Route::ClusterAllocation | Route::ClusterReplicationFactor => {
            allocation::handle(&node, route, &context).await
        }
        Route::ChangeAnalysis | Route::Rebalance => {
            jobs::handle(&state, node, route, &context).await
        }
        _ => Err(unsupported(operation_of(route))),
    }
}
