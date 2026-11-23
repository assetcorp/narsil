mod admin;
mod analysis;
mod archives;
mod import;
mod import_route;
mod ndjson;
mod suggestions_build;

use std::sync::Arc;

use narsil::Narsil;

use crate::errors::{Outcome, ServerError};
use crate::handlers::common::engine_call;
use crate::http::respond::{HttpResponse, json};
use crate::state::ServerState;
use crate::tasks::{TaskFailure, TaskLaunch, TaskOperation, TaskOutcome};

#[cfg(feature = "cluster")]
pub(crate) use admin::target_partition_count;
pub(crate) use admin::{change_analysis, optimize, rebalance, rebuild_analysis};
#[cfg(feature = "cluster")]
pub(crate) use analysis::analysis_change_of;
pub(crate) use archives::{import_export, restore};
pub(crate) use import_route::import_ndjson;
pub(crate) use suggestions_build::build_query_suggestions;

pub(crate) async fn on_blocking_pool<T, F>(work: F) -> Result<T, TaskFailure>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, TaskFailure> + Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .unwrap_or(Err(TaskFailure::Unexpected))
}

pub(crate) fn engine_work<F>(engine: Arc<Narsil>, work: F) -> TaskOperation
where
    F: FnOnce(&Narsil) -> TaskOutcome + Send + 'static,
{
    Box::new(move |_context| Box::pin(on_blocking_pool(move || work(&engine))))
}

pub(crate) fn coded(failure: narsil::NarsilError) -> TaskFailure {
    TaskFailure::Coded(ServerError::from(failure))
}

pub(crate) async fn require_index(state: &Arc<ServerState>, index: &str) -> Outcome<()> {
    let index = index.to_string();
    engine_call(state, move |engine| engine.get_stats(&index).map(|_| ())).await
}

pub(crate) async fn accepted(
    state: &ServerState,
    launch: TaskLaunch,
    operation: TaskOperation,
) -> Outcome<HttpResponse> {
    let record = state.tasks.start(launch, operation).await?;
    Ok(json(202, &record.to_wire()))
}
