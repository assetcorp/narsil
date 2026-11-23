use std::sync::Arc;

use narsil::{ErrorCode, Map, Value};

use super::analysis::analysis_change_of;
use super::{accepted, coded, engine_work, require_index};
use crate::errors::{Outcome, ServerError};
use crate::handlers::common::optional_json_body;
use crate::http::pipeline::RouteContext;
use crate::http::respond::HttpResponse;
use crate::script_values::script_text;
use crate::state::ServerState;
use crate::tasks::{TaskFailure, TaskLaunch};

enum VectorField {
    Every,
    Named(String),
    Unmatchable(Value),
}

fn vector_field_of(body: &Value) -> VectorField {
    let Value::Object(fields) = body else {
        return VectorField::Every;
    };
    match fields.get("field") {
        None => VectorField::Every,
        Some(Value::String(name)) => VectorField::Named(name.clone()),
        Some(other) => VectorField::Unmatchable(other.clone()),
    }
}

fn unknown_vector_field(index: &str, field: Value) -> TaskFailure {
    let mut details = Map::new();
    details.insert("indexName", Value::String(index.to_string()));
    let shown = script_text(&field);
    details.insert("fieldName", field);
    TaskFailure::Coded(
        ServerError::coded(
            ErrorCode::INDEX_NOT_FOUND.as_str(),
            format!("Vector field \"{shown}\" not found in index \"{index}\""),
        )
        .with_details(details),
    )
}

pub(crate) async fn optimize(
    state: Arc<ServerState>,
    context: RouteContext,
) -> Outcome<HttpResponse> {
    let field = vector_field_of(&optional_json_body(&context)?);
    let index = context.param(0).to_string();
    require_index(&state, &index).await?;
    let named = index.clone();
    let operation = engine_work(Arc::clone(&state.engine), move |engine| match field {
        VectorField::Every => engine.optimize_vectors(&named, None).map_err(coded),
        VectorField::Named(field) => engine.optimize_vectors(&named, Some(&field)).map_err(coded),
        VectorField::Unmatchable(field) => Err(unknown_vector_field(&named, field)),
    });
    accepted(&state, TaskLaunch::on("optimizeVectors", &index), operation).await
}

pub(crate) async fn rebuild_analysis(
    state: Arc<ServerState>,
    context: RouteContext,
) -> Outcome<HttpResponse> {
    let index = context.param(0).to_string();
    require_index(&state, &index).await?;
    let named = index.clone();
    let operation = engine_work(Arc::clone(&state.engine), move |engine| {
        engine.rebuild_analysis(&named).map_err(coded)
    });
    accepted(&state, TaskLaunch::on("rebuildAnalysis", &index), operation).await
}

pub(crate) async fn change_analysis(
    state: Arc<ServerState>,
    context: RouteContext,
) -> Outcome<HttpResponse> {
    let change = analysis_change_of(&optional_json_body(&context)?)?;
    let index = context.param(0).to_string();
    require_index(&state, &index).await?;
    let named = index.clone();
    let operation = engine_work(Arc::clone(&state.engine), move |engine| {
        engine.change_analysis(&named, &change).map_err(coded)
    });
    accepted(&state, TaskLaunch::on("changeAnalysis", &index), operation).await
}

pub(crate) fn target_partition_count(body: &Value) -> Outcome<usize> {
    let target = match body {
        Value::Object(fields) => fields.get("targetPartitionCount"),
        _ => None,
    };
    match target {
        Some(Value::Number(count))
            if count.is_finite() && count.trunc() == *count && *count > 0.0 =>
        {
            Ok(if *count >= usize::MAX as f64 {
                usize::MAX
            } else {
                *count as usize
            })
        }
        _ => Err(ServerError::invalid(
            "Field \"targetPartitionCount\" is required and must be a positive integer",
        )),
    }
}

pub(crate) async fn rebalance(
    state: Arc<ServerState>,
    context: RouteContext,
) -> Outcome<HttpResponse> {
    let target = target_partition_count(&optional_json_body(&context)?)?;
    let index = context.param(0).to_string();
    require_index(&state, &index).await?;
    let named = index.clone();
    let operation = engine_work(Arc::clone(&state.engine), move |engine| {
        engine.rebalance(&named, target).map_err(coded)
    });
    accepted(&state, TaskLaunch::on("rebalance", &index), operation).await
}
