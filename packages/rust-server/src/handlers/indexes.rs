use std::sync::Arc;

use narsil::Value;

use super::common::{engine_call, json_object_body, object};
use crate::documents::answers::{index_info, index_stats, memory_stats, partition_stats};
use crate::documents::bodies::{create_index_request, field, with_given_values};
use crate::errors::{Outcome, ServerError};
use crate::http::pipeline::RouteContext;
use crate::http::respond::{HttpResponse, json};
use crate::http::routes::Route;
use crate::state::ServerState;

fn named(name: &str, key: &str, value: Value) -> Value {
    object(vec![
        ("name", Value::String(name.to_string())),
        (key, value),
    ])
}

async fn create(state: &Arc<ServerState>, context: &RouteContext) -> Outcome<HttpResponse> {
    let body = json_object_body(context)?;
    let (name, config) = create_index_request(&body)?;
    let created = name.clone();
    engine_call(state, move |engine| engine.create_index(&created, config))
        .await
        .map_err(|error| match field(&body, "config") {
            Some(Value::Object(given)) => with_given_values(error, given),
            _ => error,
        })?;
    Ok(json(201, &object(vec![("name", Value::String(name))])))
}

async fn list(state: &Arc<ServerState>) -> Outcome<HttpResponse> {
    let indexes = engine_call(state, |engine| Ok(engine.list_indexes())).await?;
    let listed = Value::Array(indexes.iter().map(index_info).collect());
    Ok(json(200, &object(vec![("indexes", listed)])))
}

async fn memory(state: &Arc<ServerState>) -> Outcome<HttpResponse> {
    let (stats, indexes) = engine_call(state, |engine| {
        Ok((engine.get_memory_stats(), engine.list_indexes()))
    })
    .await?;
    Ok(json(200, &memory_stats(&stats, &indexes)))
}

async fn lifecycle(state: &Arc<ServerState>, route: Route, name: String) -> Outcome<HttpResponse> {
    let index = name.clone();
    let answer = engine_call(state, move |engine| {
        let index = index.as_str();
        Ok(match route {
            Route::DropIndex => {
                engine.drop_index(index)?;
                named(index, "dropped", Value::Bool(true))
            }
            Route::ClearIndex => {
                engine.clear(index)?;
                named(index, "cleared", Value::Bool(true))
            }
            Route::OpenIndex => {
                engine.open_index(index)?;
                named(index, "state", Value::String("open".to_string()))
            }
            Route::CloseIndex => {
                engine.close_index(index)?;
                named(index, "state", Value::String("closed".to_string()))
            }
            Route::IndexStats => index_stats(engine.get_stats(index)?),
            Route::IndexPartitions => partition_stats(engine.get_partition_stats(index)?),
            _ => object(vec![(
                "count",
                Value::Number(engine.count_documents(index)? as f64),
            )]),
        })
    })
    .await?;
    Ok(json(200, &answer))
}

pub(crate) async fn handle(
    state: Arc<ServerState>,
    route: Route,
    context: RouteContext,
) -> Outcome<HttpResponse> {
    match route {
        Route::CreateIndex => create(&state, &context).await,
        Route::ListIndexes => list(&state).await,
        Route::Memory => memory(&state).await,
        Route::DropIndex
        | Route::IndexStats
        | Route::IndexPartitions
        | Route::ClearIndex
        | Route::OpenIndex
        | Route::CloseIndex
        | Route::Count => lifecycle(&state, route, context.param(0).to_string()).await,
        _ => Err(ServerError::internal()),
    }
}
