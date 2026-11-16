use std::sync::Arc;

use narsil::{SnapshotOptions, Value};

use super::bm25::update_bm25;
use super::errors::{on_engine, preparing};
use super::partition::update_partition_config;
use super::stream::streamed_write;
use super::synonyms::{synonym_rules_of, synonym_set_json};
use super::vectors::{compact, compact_target_of, maintenance_json};
use crate::constants::{DOCUMENT_EXPORT_CONTENT_TYPE, SNAPSHOT_ARCHIVE_CONTENT_TYPE};
use crate::errors::{Outcome, ServerError};
use crate::handlers::common::{json_body, object, optional_json_body};
use crate::http::pipeline::RouteContext;
use crate::http::respond::{HttpResponse, json};
use crate::http::routes::Route;
use crate::script_values::script_truthy;
use crate::state::ServerState;

const CHANGES_EXPORT_PREPARING: &str = "CHANGES_EXPORT_PREPARING";

pub(crate) fn ok() -> HttpResponse {
    json(200, &object(vec![("ok", Value::Bool(true))]))
}

fn query_history_of(context: &RouteContext) -> Outcome<bool> {
    match context.query_value("queryHistory") {
        None | Some("false") => Ok(false),
        Some("true") => Ok(true),
        Some(other) => Err(ServerError::invalid(
            "Query parameter \"queryHistory\" accepts only true or false",
        )
        .with_detail("value", Value::String(other.to_string()))),
    }
}

async fn checkpoint(state: &Arc<ServerState>, name: String) -> Outcome<HttpResponse> {
    on_engine(state, move |engine| {
        engine.checkpoint(&name).map_err(ServerError::from)
    })
    .await?;
    Ok(ok())
}

async fn snapshot(
    state: &Arc<ServerState>,
    context: &RouteContext,
    name: String,
) -> Outcome<HttpResponse> {
    let options = SnapshotOptions {
        query_history: query_history_of(context)?,
    };
    streamed_write(
        &state.engine,
        SNAPSHOT_ARCHIVE_CONTENT_TYPE,
        move |engine, out| engine.snapshot_with(&name, out, &options),
    )
    .await
}

async fn export_documents(state: &Arc<ServerState>, name: String) -> Outcome<HttpResponse> {
    streamed_write(
        &state.engine,
        DOCUMENT_EXPORT_CONTENT_TYPE,
        move |engine, out| engine.export_documents(&name, out),
    )
    .await
    .map_err(|failure| preparing(failure, CHANGES_EXPORT_PREPARING))
}

async fn vector_maintenance(state: &Arc<ServerState>, name: String) -> Outcome<HttpResponse> {
    let statuses = on_engine(state, move |engine| {
        engine
            .vector_maintenance_status(&name)
            .map_err(ServerError::from)
    })
    .await?;
    Ok(json(200, &maintenance_json(&statuses)))
}

async fn compact_vectors(
    state: &Arc<ServerState>,
    context: &RouteContext,
    name: String,
) -> Outcome<HttpResponse> {
    let target = compact_target_of(&optional_json_body(context)?);
    on_engine(state, move |engine| compact(engine, &name, target)).await?;
    Ok(ok())
}

async fn partition_config(
    state: &Arc<ServerState>,
    context: &RouteContext,
    name: String,
) -> Outcome<HttpResponse> {
    let body = optional_json_body(context)?;
    if !script_truthy(&body) {
        return Err(ServerError::invalid(
            "Send the partition settings as a JSON object",
        ));
    }
    on_engine(state, move |engine| {
        update_partition_config(engine, &name, &body)
    })
    .await?;
    Ok(ok())
}

async fn read_synonyms(state: &Arc<ServerState>, name: String) -> Outcome<HttpResponse> {
    let rules = on_engine(state, move |engine| {
        engine.get_synonyms(&name).map_err(ServerError::from)
    })
    .await?;
    Ok(json(200, &synonym_set_json(&rules)))
}

async fn replace_synonyms(
    state: &Arc<ServerState>,
    context: &RouteContext,
    name: String,
) -> Outcome<HttpResponse> {
    let body = json_body(context)?;
    let rules = match body {
        Value::Object(mut fields) if fields.contains_key("synonyms") => {
            fields.remove("synonyms").unwrap_or(Value::Null)
        }
        _ => {
            return Err(ServerError::invalid(
                "Send the synonym set as { \"synonyms\": [ ...rules ] }",
            ));
        }
    };
    on_engine(state, move |engine| {
        engine.get_synonyms(&name).map_err(ServerError::from)?;
        let rules = synonym_rules_of(&rules)?;
        engine
            .update_synonyms(&name, &rules)
            .map_err(ServerError::from)
    })
    .await?;
    Ok(ok())
}

async fn replace_bm25(
    state: &Arc<ServerState>,
    context: &RouteContext,
    name: String,
) -> Outcome<HttpResponse> {
    let body = json_body(context)?;
    on_engine(state, move |engine| update_bm25(engine, &name, &body)).await?;
    Ok(ok())
}

pub(crate) async fn handle(
    state: Arc<ServerState>,
    route: Route,
    context: RouteContext,
) -> Outcome<HttpResponse> {
    let name = context.param(0).to_string();
    match route {
        Route::Checkpoint => checkpoint(&state, name).await,
        Route::Snapshot => snapshot(&state, &context, name).await,
        Route::VectorMaintenance => vector_maintenance(&state, name).await,
        Route::Compact => compact_vectors(&state, &context, name).await,
        Route::PartitionConfig => partition_config(&state, &context, name).await,
        Route::ReadSynonyms => read_synonyms(&state, name).await,
        Route::ReplaceSynonyms => replace_synonyms(&state, &context, name).await,
        Route::UpdateBm25 => replace_bm25(&state, &context, name).await,
        Route::ExportDocuments => export_documents(&state, name).await,
        _ => Err(ServerError::internal()),
    }
}
