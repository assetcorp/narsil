use narsil::Value;
use narsil_cluster::node::ClusterNode;

use super::served_error;
use crate::documents::bodies::{create_index_request, field, with_given_values};
use crate::errors::{Outcome, ServerError};
use crate::handlers::common::{json_object_body, object};
use crate::http::pipeline::RouteContext;
use crate::http::respond::{HttpResponse, json};
use crate::http::routes::Route;
use crate::state::ServerState;

async fn create(
    state: &ServerState,
    node: &ClusterNode,
    context: &RouteContext,
) -> Outcome<HttpResponse> {
    let body = json_object_body(context)?;
    let (name, config) = create_index_request(&body)?;
    let options = state.cluster_options.create_index.clone();
    node.create_index(&name, config, options)
        .await
        .map_err(|error| match field(&body, "config") {
            Some(Value::Object(given)) => with_given_values(served_error(error), given),
            _ => served_error(error),
        })?;
    Ok(json(201, &object(vec![("name", Value::String(name))])))
}

async fn drop_index(node: &ClusterNode, context: &RouteContext) -> Outcome<HttpResponse> {
    let name = context.param(0);
    node.drop_index(name).await.map_err(served_error)?;
    Ok(json(
        200,
        &object(vec![
            ("name", Value::String(name.to_string())),
            ("dropped", Value::Bool(true)),
        ]),
    ))
}

pub(super) async fn handle(
    state: &ServerState,
    node: &ClusterNode,
    route: Route,
    context: &RouteContext,
) -> Outcome<HttpResponse> {
    match route {
        Route::CreateIndex => create(state, node, context).await,
        Route::DropIndex => drop_index(node, context).await,
        _ => Err(ServerError::internal()),
    }
}
