use narsil::Value;
use narsil_cluster::node::ClusterNode;

use super::served_error;
use crate::documents::answers::memory_stats;
use crate::errors::{Outcome, ServerError};
use crate::handlers::common::{json_body, object};
use crate::http::pipeline::RouteContext;
use crate::http::respond::{HttpResponse, json};
use crate::http::routes::Route;
use crate::settings::{Bm25Change, bm25_change_of, ok, provoked_refusal, synonym_set_json};

const SYNONYM_SET_SHAPE: &str = "Send the synonym set as { \"synonyms\": [ ...rules ] }";

fn named(index_name: &str, key: &str, value: Value) -> HttpResponse {
    let answer = object(vec![
        ("name", Value::String(index_name.to_string())),
        (key, value),
    ]);
    json(200, &answer)
}

async fn memory(node: &ClusterNode) -> Outcome<HttpResponse> {
    let local = node.local_memory_stats().await.map_err(served_error)?;
    Ok(json(200, &memory_stats(&local.stats, &local.indexes)))
}

async fn replace_synonyms(
    node: &ClusterNode,
    context: &RouteContext,
    index_name: &str,
) -> Outcome<HttpResponse> {
    let rules = match json_body(context)? {
        Value::Object(mut fields) if fields.contains_key("synonyms") => {
            fields.remove("synonyms").unwrap_or(Value::Null)
        }
        _ => return Err(ServerError::invalid(SYNONYM_SET_SHAPE)),
    };
    node.replace_synonyms_json(index_name, &rules)
        .await
        .map_err(served_error)?;
    Ok(ok())
}

async fn update_bm25(
    node: &ClusterNode,
    context: &RouteContext,
    index_name: &str,
) -> Outcome<HttpResponse> {
    let body = json_body(context)?;
    match bm25_change_of(&body) {
        Bm25Change::Valid(bm25) => {
            node.update_bm25(index_name, &bm25)
                .await
                .map_err(served_error)?;
            Ok(ok())
        }
        Bm25Change::Refused { sentinel, failure } => {
            match node.update_bm25(index_name, &sentinel).await {
                Err(raised) => {
                    let raised = served_error(raised);
                    Err(if provoked_refusal(&raised) {
                        failure
                    } else {
                        raised
                    })
                }
                Ok(()) => Err(failure),
            }
        }
    }
}

pub(super) async fn handle(
    node: &ClusterNode,
    route: Route,
    context: &RouteContext,
) -> Outcome<HttpResponse> {
    let index_name = context.param(0);
    match route {
        Route::Memory => memory(node).await,
        Route::ClearIndex => {
            node.clear(index_name).await.map_err(served_error)?;
            Ok(named(index_name, "cleared", Value::Bool(true)))
        }
        Route::OpenIndex => {
            node.open_index(index_name).await.map_err(served_error)?;
            Ok(named(index_name, "state", Value::from("open")))
        }
        Route::CloseIndex => {
            node.close_index(index_name).await.map_err(served_error)?;
            Ok(named(index_name, "state", Value::from("closed")))
        }
        Route::Checkpoint => {
            node.checkpoint(index_name).await.map_err(served_error)?;
            Ok(ok())
        }
        Route::ReadSynonyms => {
            let rules = node.synonyms(index_name).await.map_err(served_error)?;
            Ok(json(200, &synonym_set_json(&rules)))
        }
        Route::ReplaceSynonyms => replace_synonyms(node, context, index_name).await,
        Route::UpdateBm25 => update_bm25(node, context, index_name).await,
        _ => Err(ServerError::internal()),
    }
}
