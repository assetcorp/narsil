mod allocation;
mod backups;
mod feed_settings;
mod indexes;
mod jobs;
mod operations;
mod options;
mod queries;
mod reads;
mod snapshots;
mod suggestions;
mod writes;

use std::sync::Arc;

use narsil::{Map, Value};
use narsil_cluster::error::ClusterError;
use narsil_cluster::node::{ClusterNode, NodeReadiness};

use self::operations::operation_of;
pub(crate) use self::operations::unsupported;
pub use self::options::ClusterOptions;
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
        Route::Get
        | Route::Exists
        | Route::MultiGet
        | Route::Put
        | Route::ListIndexes
        | Route::Count
        | Route::IndexStats
        | Route::IndexPartitions => reads::handle(&state, &node, route, &context).await,
        Route::CreateBackup | Route::ListBackups | Route::RestoreBackup | Route::DeleteBackup => {
            backups::handle(&state, node, route, &context).await
        }
        Route::CreateIndex | Route::DropIndex => {
            indexes::handle(&state, &node, route, &context).await
        }
        Route::Search | Route::Preflight | Route::Suggest | Route::List => {
            queries::handle(&state, &node, route, &context).await
        }
        Route::UpdateQuerySuggestions
        | Route::QuerySuggestionsStatus
        | Route::RecordQuery
        | Route::BuildQuerySuggestions
        | Route::PreviewQuerySuggestions
        | Route::ReadQueryBans
        | Route::ReplaceQueryBans
        | Route::RemoveQuery
        | Route::AddManualSuggestion => suggestions::handle(&state, node, route, context).await,
        Route::SyncSnapshot => snapshots::sync_snapshot(&state, &node, &context).await,
        Route::ExportDocuments => snapshots::export_documents(&node, &context).await,
        _ => Err(unsupported(operation_of(route))),
    }
}
