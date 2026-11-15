use std::fs::File;
use std::io::BufReader;
use std::sync::Arc;

use narsil::{DocumentImportResult, Map, Narsil, Value};

use super::import::import_result;
use super::{accepted, coded, on_blocking_pool};
use crate::errors::{Outcome, ServerError, server_codes};
use crate::http::pipeline::RouteContext;
use crate::http::respond::HttpResponse;
use crate::http::spool::SpooledBody;
use crate::state::ServerState;
use crate::tasks::{TaskContext, TaskFailure, TaskLaunch, TaskOperation, TaskOutcome};

fn spooled_body(context: &mut RouteContext) -> Outcome<SpooledBody> {
    match context.spooled.take() {
        Some(spooled) if spooled.bytes > 0 => Ok(spooled),
        _ => Err(ServerError::new(
            400,
            server_codes::EMPTY_BODY,
            "Request body is empty",
        )),
    }
}

fn reading_spool<F>(engine: Arc<Narsil>, spooled: SpooledBody, work: F) -> TaskOperation
where
    F: FnOnce(&Narsil, &mut BufReader<File>, &TaskContext) -> TaskOutcome + Send + 'static,
{
    Box::new(move |context: TaskContext| {
        Box::pin(on_blocking_pool(move || {
            let outcome = match File::open(spooled.path()) {
                Ok(file) => work(&engine, &mut BufReader::new(file), &context),
                Err(_) => Err(TaskFailure::Unexpected),
            };
            drop(spooled);
            outcome
        }))
    })
}

fn result_of(result: DocumentImportResult, max_errors: u64) -> Map {
    let errors: Vec<Value> = result
        .refused
        .into_iter()
        .take(usize::try_from(max_errors).unwrap_or(usize::MAX))
        .map(|refusal| {
            let mut error = Map::new();
            error.insert("line", Value::Number(refusal.line as f64));
            error.insert("code", Value::String(refusal.code.as_str().to_string()));
            error.insert("message", Value::String(refusal.message));
            Value::Object(error)
        })
        .collect();
    import_result(result.imported, result.refused_count, errors)
}

pub(crate) async fn restore(
    state: Arc<ServerState>,
    mut context: RouteContext,
) -> Outcome<HttpResponse> {
    let spooled = spooled_body(&mut context)?;
    let index = context.param(0).to_string();
    let named = index.clone();
    let operation = reading_spool(
        Arc::clone(&state.engine),
        spooled,
        move |engine, archive, _context| engine.restore(&named, archive).map_err(coded),
    );
    accepted(&state, TaskLaunch::on("restore", &index), operation).await
}

pub(crate) async fn import_export(
    state: Arc<ServerState>,
    mut context: RouteContext,
) -> Outcome<HttpResponse> {
    let spooled = spooled_body(&mut context)?;
    let index = context.param(0).to_string();
    let named = index.clone();
    let max_errors = state.limits.max_import_errors;
    let operation = reading_spool(
        Arc::clone(&state.engine),
        spooled,
        move |engine, export, context| {
            let result = engine.import_documents(&named, export).map_err(coded)?;
            context.report_result(result_of(result, max_errors));
            Ok(())
        },
    );
    accepted(&state, TaskLaunch::on("importExport", &index), operation).await
}
