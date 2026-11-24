use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use bytes::Bytes;
use narsil::{Map, Narsil};

use super::import::{
    ImportRun, ImportSettings, ImportedBatch, engine_insert, progress_of, run_import,
};
use super::{accepted, on_blocking_pool};
use crate::errors::{Outcome, ServerError, server_codes};
use crate::handlers::common::engine_call;
use crate::http::pipeline::RouteContext;
use crate::http::respond::{HttpResponse, json};
use crate::state::ServerState;
use crate::tasks::{TaskContext, TaskFailure, TaskLaunch, TaskOperation};

pub(crate) type SharedBatchInsert =
    Arc<dyn Fn(Vec<Map>) -> Result<ImportedBatch, TaskFailure> + Send + Sync>;

struct CancelOnDrop {
    cancelled: Arc<AtomicBool>,
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
    }
}

pub(crate) struct ImportTarget {
    pub(crate) engine: Arc<Narsil>,
    pub(crate) index: String,
    pub(crate) insert: SharedBatchInsert,
}

fn import_task(target: ImportTarget, body: Bytes, settings: ImportSettings) -> TaskOperation {
    Box::new(move |context: TaskContext| {
        Box::pin(on_blocking_pool(move || {
            let cancelled = || context.is_cancelled();
            let on_progress = |progress| context.report_progress(progress);
            let result = run_import(&ImportRun {
                engine: &target.engine,
                insert: &*target.insert,
                body: &body,
                settings: &settings,
                cancelled: &cancelled,
                on_progress: &on_progress,
            })?;
            context.report_result(result);
            Ok(())
        }))
    })
}

async fn import_inline(
    target: ImportTarget,
    body: Bytes,
    settings: ImportSettings,
) -> Outcome<HttpResponse> {
    let cancelled = Arc::new(AtomicBool::new(false));
    let guard = CancelOnDrop {
        cancelled: Arc::clone(&cancelled),
    };
    let imported = on_blocking_pool(move || {
        let stopped = || cancelled.load(Ordering::Acquire);
        run_import(&ImportRun {
            engine: &target.engine,
            insert: &*target.insert,
            body: &body,
            settings: &settings,
            cancelled: &stopped,
            on_progress: &|_| {},
        })
    })
    .await;
    drop(guard);
    match imported {
        Ok(result) => Ok(json(200, &narsil::Value::Object(result))),
        Err(TaskFailure::Coded(failure)) => Err(failure),
        Err(TaskFailure::Unexpected) => Err(ServerError::internal()),
    }
}

pub(crate) fn import_body(context: &RouteContext) -> Outcome<Bytes> {
    match context.body.clone() {
        Some(body) if !body.is_empty() => Ok(body),
        _ => Err(ServerError::new(
            400,
            server_codes::EMPTY_BODY,
            "Request body is empty",
        )),
    }
}

pub(crate) fn runs_as_task(context: &RouteContext) -> bool {
    context.query_value("async") == Some("true")
}

pub(crate) async fn import_into(
    state: &ServerState,
    target: ImportTarget,
    body: Bytes,
    as_task: bool,
) -> Outcome<HttpResponse> {
    let settings = ImportSettings::of(&state.limits);
    if !as_task {
        return import_inline(target, body, settings).await;
    }
    let launch = TaskLaunch {
        progress: Some(progress_of(0, 0, 0, body.len())),
        ..TaskLaunch::on("import", &target.index)
    };
    let operation = import_task(target, body, settings);
    accepted(state, launch, operation).await
}

pub(crate) async fn import_ndjson(
    state: Arc<ServerState>,
    context: RouteContext,
) -> Outcome<HttpResponse> {
    let body = import_body(&context)?;
    let index = context.param(0).to_string();
    let as_task = runs_as_task(&context);
    if as_task {
        let counted = index.clone();
        engine_call(&state, move |engine| engine.count_documents(&counted)).await?;
    }
    let engine = Arc::clone(&state.engine);
    let inserting = Arc::clone(&engine);
    let named = index.clone();
    let target = ImportTarget {
        engine,
        index,
        insert: Arc::new(move |documents| engine_insert(&inserting, &named, documents)),
    };
    import_into(&state, target, body, as_task).await
}
