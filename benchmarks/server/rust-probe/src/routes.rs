use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::{delete, get, post};
use narsil::Narsil;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use crate::errors::ApiError;
use crate::import::run_import;
use crate::index_config::CreateIndexBody;
use crate::pool::CpuPool;
use crate::respond::{json_response, ok, parse_body, parse_optional_body};
use crate::search::{SearchBody, wire_result};
use crate::settings::Settings;
use crate::tasks::TaskStore;

#[derive(Clone)]
pub struct AppState {
    pub engine: Arc<Narsil>,
    pub pool: Arc<CpuPool>,
    pub tasks: Arc<TaskStore>,
    pub settings: Arc<Settings>,
}

type Answer = Result<Response, ApiError>;

fn body_bytes(body: Result<Bytes, BytesRejection>) -> Result<Bytes, ApiError> {
    body.map_err(|rejection| {
        let status = rejection.status();
        if status == StatusCode::PAYLOAD_TOO_LARGE {
            ApiError::new(
                status,
                "PAYLOAD_TOO_LARGE",
                "Request body exceeds the configured size limit",
            )
        } else {
            ApiError::new(status, "INVALID_REQUEST", rejection.body_text())
        }
    })
}

fn raw_json(value: &narsil::Value) -> Result<Box<RawValue>, ApiError> {
    RawValue::from_string(narsil::write_json(value))
        .map_err(|_| ApiError::internal("A value could not be written as JSON"))
}

async fn readyz() -> Response {
    ok(&serde_json::json!({ "status": "ready" }))
}

async fn version(State(state): State<AppState>) -> Response {
    let build = &state.settings.build;
    ok(&serde_json::json!({
        "name": "narsil",
        "implementation": "rust-probe",
        "version": build.version,
        "gitSha": build.git_sha,
        "dirty": build.dirty,
        "vectorSearch": "native",
    }))
}

async fn create_index(
    State(state): State<AppState>,
    body: Result<Bytes, BytesRejection>,
) -> Answer {
    let request: CreateIndexBody = parse_body(&body_bytes(body)?)?;
    let config = request.config.into_config()?;
    let name = request.name;
    let engine = Arc::clone(&state.engine);
    let created = name.clone();
    state
        .pool
        .run(move || engine.create_index(&created, config))
        .await??;
    Ok(json_response(
        StatusCode::CREATED,
        &serde_json::json!({ "name": name }),
    ))
}

async fn drop_index(State(state): State<AppState>, Path(name): Path<String>) -> Answer {
    let engine = Arc::clone(&state.engine);
    let dropped = name.clone();
    state
        .pool
        .run(move || engine.drop_index(&dropped))
        .await??;
    Ok(ok(&serde_json::json!({ "name": name, "dropped": true })))
}

async fn count(State(state): State<AppState>, Path(name): Path<String>) -> Answer {
    let engine = Arc::clone(&state.engine);
    let total = state
        .pool
        .run(move || engine.count_documents(&name))
        .await??;
    Ok(ok(&serde_json::json!({ "count": total })))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireIndexStats {
    document_count: u64,
    partition_count: usize,
    estimated_memory_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    saved_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    log_bytes: Option<u64>,
    language: String,
    schema: Box<RawValue>,
}

async fn index_stats(State(state): State<AppState>, Path(name): Path<String>) -> Answer {
    let engine = Arc::clone(&state.engine);
    let stats = state.pool.run(move || engine.get_stats(&name)).await??;
    Ok(ok(&WireIndexStats {
        document_count: stats.document_count,
        partition_count: stats.partition_count,
        estimated_memory_bytes: stats.estimated_memory_bytes,
        saved_bytes: stats.saved_bytes,
        log_bytes: stats.log_bytes,
        language: stats.language,
        schema: raw_json(&stats.schema)?,
    }))
}

async fn memory_stats(State(state): State<AppState>) -> Answer {
    let engine = Arc::clone(&state.engine);
    let stats = state.pool.run(move || engine.get_memory_stats()).await?;
    Ok(ok(&serde_json::json!({
        "process": { "rss": stats.process_resident_bytes },
        "estimatedIndexBytes": stats.estimated_index_bytes,
        "openIndexCount": stats.open_index_count,
        "workers": [],
        "workerCopies": [],
        "requestThreads": state.settings.http_threads,
        "searchThreads": state.pool.threads(),
    })))
}

async fn search(
    State(state): State<AppState>,
    Path(name): Path<String>,
    body: Result<Bytes, BytesRejection>,
) -> Answer {
    let request: SearchBody = parse_body(&body_bytes(body)?)?;
    let params = request.into_params()?;
    let engine = Arc::clone(&state.engine);
    let wire = state
        .pool
        .run(move || -> Result<_, ApiError> { wire_result(engine.query(&name, &params)?) })
        .await??;
    Ok(ok(&wire))
}

async fn import(
    State(state): State<AppState>,
    Path(name): Path<String>,
    body: Result<Bytes, BytesRejection>,
) -> Answer {
    let bytes = body_bytes(body)?;
    let engine = Arc::clone(&state.engine);
    let outcome = state
        .pool
        .run(move || run_import(&engine, &name, &bytes))
        .await??;
    Ok(ok(&outcome))
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct VectorFieldBody {
    field: Option<String>,
}

async fn optimize(
    State(state): State<AppState>,
    Path(name): Path<String>,
    body: Result<Bytes, BytesRejection>,
) -> Answer {
    let request: VectorFieldBody = parse_optional_body(&body_bytes(body)?)?;
    let engine = Arc::clone(&state.engine);
    let checked = name.clone();
    state
        .pool
        .run(move || engine.count_documents(&checked))
        .await??;
    let record = state
        .tasks
        .start_optimize(Arc::clone(&state.engine), name, request.field)?;
    Ok(json_response(StatusCode::ACCEPTED, &record))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireMaintenance {
    field_name: String,
    tombstone_ratio: f64,
    graph_count: u32,
    buffer_size: u64,
    building: bool,
    waiting_for_memory: bool,
    loading_from_files: bool,
    estimated_compact_ms: u64,
    estimated_optimize_ms: u64,
}

async fn vector_maintenance(State(state): State<AppState>, Path(name): Path<String>) -> Answer {
    let engine = Arc::clone(&state.engine);
    let queried = name.clone();
    let fields = state
        .pool
        .run(move || engine.vector_maintenance_status(&queried))
        .await??;
    let optimizing = state.tasks.building_indexes().contains(&name);
    let wire: Vec<WireMaintenance> = fields
        .into_iter()
        .map(|field| WireMaintenance {
            field_name: field.field_name,
            tombstone_ratio: field.tombstone_ratio,
            graph_count: field.graph_count,
            buffer_size: field.buffer_size,
            building: field.building || optimizing,
            waiting_for_memory: field.waiting_for_memory,
            loading_from_files: field.loading_from_files,
            estimated_compact_ms: field.estimated_compact_ms,
            estimated_optimize_ms: field.estimated_optimize_ms,
        })
        .collect();
    Ok(ok(&serde_json::json!({ "fields": wire })))
}

async fn task(State(state): State<AppState>, Path(id): Path<String>) -> Answer {
    match state.tasks.get(&id) {
        Some(record) => Ok(ok(&record)),
        None => Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "TASK_NOT_FOUND",
            format!("Task \"{id}\" not found"),
        )),
    }
}

pub fn router(state: AppState) -> Router {
    let max_body = state.settings.max_body_bytes;
    let max_import = state.settings.max_import_bytes;
    Router::new()
        .route("/readyz", get(readyz))
        .route("/version", get(version))
        .route("/stats/memory", get(memory_stats))
        .route("/tasks/{id}", get(task))
        .route("/indexes", post(create_index))
        .route("/indexes/{name}", delete(drop_index))
        .route("/indexes/{name}/count", get(count))
        .route("/indexes/{name}/stats", get(index_stats))
        .route("/indexes/{name}/search", post(search))
        .route(
            "/indexes/{name}/documents/_import",
            post(import).layer(DefaultBodyLimit::max(max_import)),
        )
        .route("/indexes/{name}/vectors/_optimize", post(optimize))
        .route(
            "/indexes/{name}/vector-maintenance",
            get(vector_maintenance),
        )
        .layer(DefaultBodyLimit::max(max_body))
        .with_state(state)
}
