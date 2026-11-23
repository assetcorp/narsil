use narsil::Value;
use narsil_cluster::node::{ClusterNode, WriteBatchResult};

use super::{served_error, unsupported};
use crate::documents::batch::{
    BatchRequest, SplitEntries, WireBatch, WireFailure, batch_request, split_documents,
    split_removals, split_updates,
};
use crate::documents::bodies::{ChosenId, document_of, field, insert_id_of};
use crate::errors::{Outcome, ServerError};
use crate::handlers::common::{json_object_body, object};
use crate::http::pipeline::RouteContext;
use crate::http::respond::{HttpResponse, json};
use crate::http::routes::Route;
use crate::state::ServerState;

const WAIT_OPERATION: &str = "wait";

pub(super) fn refuse_wait(body: &Value) -> Outcome<()> {
    let waits = field(body, "options")
        .and_then(|options| field(options, "wait"))
        .is_some_and(|wait| *wait == Value::Bool(true));
    if waits {
        return Err(unsupported(WAIT_OPERATION));
    }
    Ok(())
}

fn id_answer(id: String) -> Value {
    object(vec![("id", Value::String(id))])
}

async fn insert(node: &ClusterNode, context: &RouteContext) -> Outcome<HttpResponse> {
    let mut body = json_object_body(context)?;
    let document = document_of(&mut body)?;
    refuse_wait(&body)?;
    let index = context.param(0);
    let given = match insert_id_of(&body, &document) {
        ChosenId::Refused(refusal) => return Err(refusal),
        ChosenId::Given(id) => Some(id),
        ChosenId::Absent => None,
    };
    let id = node
        .insert(index, document, given.as_deref())
        .await
        .map_err(served_error)?;
    Ok(json(201, &id_answer(id)))
}

async fn patch(node: &ClusterNode, context: &RouteContext) -> Outcome<HttpResponse> {
    let mut body = json_object_body(context)?;
    let document = document_of(&mut body)?;
    refuse_wait(&body)?;
    let id = context.param(1).to_string();
    node.update(context.param(0), &id, document)
        .await
        .map_err(served_error)?;
    Ok(json(200, &id_answer(id)))
}

async fn remove(node: &ClusterNode, context: &RouteContext) -> Outcome<HttpResponse> {
    if context.query_value(WAIT_OPERATION) == Some("true") {
        return Err(unsupported(WAIT_OPERATION));
    }
    let id = context.param(1).to_string();
    node.remove(context.param(0), &id)
        .await
        .map_err(served_error)?;
    let answer = object(vec![
        ("id", Value::String(id)),
        ("removed", Value::Bool(true)),
    ]);
    Ok(json(200, &answer))
}

fn wire_batch(refused: Vec<WireFailure>, result: WriteBatchResult) -> WireBatch {
    let failed = result
        .failed
        .into_iter()
        .map(|failure| (failure.document_id, served_error(failure.error)));
    WireBatch::of(refused, result.succeeded, failed)
}

async fn batch(
    state: &ServerState,
    node: &ClusterNode,
    context: &RouteContext,
) -> Outcome<HttpResponse> {
    let body = json_object_body(context)?;
    let waits = refuse_wait(&body);
    let request = batch_request(body)?;
    waits?;
    let index = context.param(0);
    let written = match request {
        BatchRequest::Insert(entries) => {
            let SplitEntries { accepted, refused } =
                split_documents(&state.engine, entries).map_err(ServerError::from)?;
            let result = node.insert_batch(index, accepted).await;
            wire_batch(refused, result.map_err(served_error)?)
        }
        BatchRequest::Update(entries) => {
            let SplitEntries { accepted, refused } = split_updates(entries);
            let result = node.update_batch(index, accepted).await;
            wire_batch(refused, result.map_err(served_error)?)
        }
        BatchRequest::Remove(entries) => {
            let SplitEntries { accepted, refused } = split_removals(entries);
            let result = node.remove_batch(index, accepted).await;
            wire_batch(refused, result.map_err(served_error)?)
        }
    };
    Ok(json(200, &written.to_value()))
}

pub(super) async fn handle(
    state: &ServerState,
    node: &ClusterNode,
    route: Route,
    context: &RouteContext,
) -> Outcome<HttpResponse> {
    match route {
        Route::Insert => insert(node, context).await,
        Route::Patch => patch(node, context).await,
        Route::Remove => remove(node, context).await,
        Route::Batch => batch(state, node, context).await,
        _ => Err(ServerError::internal()),
    }
}
