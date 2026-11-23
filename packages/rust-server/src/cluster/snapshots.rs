use std::sync::Arc;

use narsil_cluster::node::ClusterNode;

use super::served_error;
use crate::constants::DOCUMENT_EXPORT_CONTENT_TYPE;
use crate::errors::Outcome;
use crate::http::pipeline::RouteContext;
use crate::http::respond::HttpResponse;
use crate::settings::{
    CHANGES_EXPORT_PREPARING, SYNC_SNAPSHOT_PREPARING, preparing, require_sync_feed,
    serve_snapshot, streamed_output,
};
use crate::state::ServerState;

pub(super) async fn sync_snapshot(
    state: &ServerState,
    node: &ClusterNode,
    context: &RouteContext,
) -> Outcome<HttpResponse> {
    require_sync_feed(state)?;
    let snapshot = node
        .sync_snapshot(context.param(0))
        .await
        .map_err(|error| preparing(served_error(error), SYNC_SNAPSHOT_PREPARING))?;
    serve_snapshot(context, Arc::new(snapshot)).await
}

pub(super) async fn export_documents(
    node: &ClusterNode,
    context: &RouteContext,
) -> Outcome<HttpResponse> {
    let export = node
        .export_documents(context.param(0))
        .await
        .map_err(|error| preparing(served_error(error), CHANGES_EXPORT_PREPARING))?;
    streamed_output(DOCUMENT_EXPORT_CONTENT_TYPE, move |out| {
        export.write_to(out)
    })
    .await
}
