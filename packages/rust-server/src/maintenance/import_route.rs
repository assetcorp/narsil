use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use bytes::Bytes;
use narsil::Narsil;

use super::import::{ImportRun, ImportSettings, progress_of, run_import};
use super::{accepted, on_blocking_pool};
use crate::errors::{Outcome, ServerError, server_codes};
use crate::handlers::common::engine_call;
use crate::http::pipeline::RouteContext;
use crate::http::respond::{HttpResponse, json};
use crate::state::ServerState;
use crate::tasks::{TaskContext, TaskFailure, TaskLaunch, TaskOperation};

struct CancelOnDrop {
    cancelled: Arc<AtomicBool>,
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
    }
}

fn import_task(
    engine: Arc<Narsil>,
    index: String,
    body: Bytes,
    settings: ImportSettings,
) -> TaskOperation {
    Box::new(move |context: TaskContext| {
        Box::pin(on_blocking_pool(move || {
            let cancelled = || context.is_cancelled();
            let on_progress = |progress| context.report_progress(progress);
            let result = run_import(&ImportRun {
                engine: &engine,
                index: &index,
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
    state: &ServerState,
    index: String,
    body: Bytes,
    settings: ImportSettings,
) -> Outcome<HttpResponse> {
    let engine = Arc::clone(&state.engine);
    let cancelled = Arc::new(AtomicBool::new(false));
    let guard = CancelOnDrop {
        cancelled: Arc::clone(&cancelled),
    };
    let imported = on_blocking_pool(move || {
        let stopped = || cancelled.load(Ordering::Acquire);
        run_import(&ImportRun {
            engine: &engine,
            index: &index,
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

pub(crate) async fn import_ndjson(
    state: Arc<ServerState>,
    context: RouteContext,
) -> Outcome<HttpResponse> {
    let body = match context.body.clone() {
        Some(body) if !body.is_empty() => body,
        _ => {
            return Err(ServerError::new(
                400,
                server_codes::EMPTY_BODY,
                "Request body is empty",
            ));
        }
    };
    let index = context.param(0).to_string();
    let settings = ImportSettings::of(&state.limits);
    if context.query_value("async") != Some("true") {
        return import_inline(&state, index, body, settings).await;
    }
    let counted = index.clone();
    engine_call(&state, move |engine| engine.count_documents(&counted)).await?;
    let launch = TaskLaunch {
        progress: Some(progress_of(0, 0, 0, body.len())),
        ..TaskLaunch::on("import", &index)
    };
    let operation = import_task(Arc::clone(&state.engine), index, body, settings);
    accepted(&state, launch, operation).await
}
