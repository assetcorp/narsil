use std::sync::Arc;

use narsil_cluster::node::ClusterNode;

use super::served_error;
use crate::errors::{Outcome, ServerError};
use crate::handlers::common::optional_json_body;
use crate::http::pipeline::RouteContext;
use crate::http::respond::HttpResponse;
use crate::http::routes::Route;
use crate::maintenance::{accepted, analysis_change_of, target_partition_count};
use crate::state::ServerState;
use crate::tasks::{TaskFailure, TaskLaunch, TaskOperation};

fn failed(error: narsil_cluster::error::ClusterError) -> TaskFailure {
    TaskFailure::Coded(served_error(error))
}

async fn require_index(node: &ClusterNode, index: &str) -> Outcome<()> {
    node.get_stats(index).await.map_err(served_error)?;
    Ok(())
}

async fn change_analysis(
    state: &ServerState,
    node: Arc<ClusterNode>,
    context: &RouteContext,
) -> Outcome<HttpResponse> {
    let change = analysis_change_of(&optional_json_body(context)?)?;
    let index = context.param(0).to_string();
    require_index(&node, &index).await?;
    let named = index.clone();
    let operation: TaskOperation = Box::new(move |_context| {
        Box::pin(async move { node.change_analysis(&named, &change).await.map_err(failed) })
    });
    accepted(state, TaskLaunch::on("changeAnalysis", &index), operation).await
}

async fn rebuild_analysis(
    state: &ServerState,
    node: Arc<ClusterNode>,
    context: &RouteContext,
) -> Outcome<HttpResponse> {
    let index = context.param(0).to_string();
    require_index(&node, &index).await?;
    let named = index.clone();
    let operation: TaskOperation = Box::new(move |_context| {
        Box::pin(async move { node.rebuild_analysis(&named).await.map_err(failed) })
    });
    accepted(state, TaskLaunch::on("rebuildAnalysis", &index), operation).await
}

async fn rebalance(
    state: &ServerState,
    node: Arc<ClusterNode>,
    context: &RouteContext,
) -> Outcome<HttpResponse> {
    let target = target_partition_count(&optional_json_body(context)?)?;
    let target = u64::try_from(target).unwrap_or(u64::MAX);
    let index = context.param(0).to_string();
    require_index(&node, &index).await?;
    let named = index.clone();
    let operation: TaskOperation = Box::new(move |_context| {
        Box::pin(async move { node.rebalance(&named, target).await.map_err(failed) })
    });
    accepted(state, TaskLaunch::on("rebalance", &index), operation).await
}

pub(super) async fn handle(
    state: &ServerState,
    node: Arc<ClusterNode>,
    route: Route,
    context: &RouteContext,
) -> Outcome<HttpResponse> {
    match route {
        Route::ChangeAnalysis => change_analysis(state, node, context).await,
        Route::Rebalance => rebalance(state, node, context).await,
        Route::RebuildAnalysis => rebuild_analysis(state, node, context).await,
        _ => Err(ServerError::internal()),
    }
}
