use std::sync::Arc;

use narsil::Map;
use narsil_cluster::node::{ClusterNode, WriteBatchResult};
use tokio::runtime::Handle;

use super::served_error;
use crate::errors::Outcome;
use crate::http::pipeline::RouteContext;
use crate::http::respond::HttpResponse;
use crate::maintenance::{
    ImportTarget, ImportedBatch, document_failure, import_body, import_into, runs_as_task,
};
use crate::state::ServerState;
use crate::tasks::TaskFailure;

fn imported(written: WriteBatchResult) -> ImportedBatch {
    let failures = written
        .failed
        .into_iter()
        .map(|failure| {
            let refusal = served_error(failure.error);
            document_failure(
                failure.document_id,
                &refusal.code,
                &refusal.message,
                refusal.details.as_ref(),
            )
        })
        .collect();
    ImportedBatch {
        indexed: written.succeeded.len() as u64,
        failures,
    }
}

fn cluster_insert(
    node: Arc<ClusterNode>,
    index: String,
) -> impl Fn(Vec<Map>) -> Result<ImportedBatch, TaskFailure> + Send + Sync {
    let runtime = Handle::current();
    move |documents| {
        runtime
            .block_on(node.insert_batch(&index, documents))
            .map(imported)
            .map_err(|error| TaskFailure::Coded(served_error(error)))
    }
}

pub(super) async fn import_ndjson(
    state: &ServerState,
    node: Arc<ClusterNode>,
    context: &RouteContext,
) -> Outcome<HttpResponse> {
    let body = import_body(context)?;
    let index = context.param(0).to_string();
    let as_task = runs_as_task(context);
    if as_task {
        node.count_documents(&index).await.map_err(served_error)?;
    }
    let target = ImportTarget {
        engine: Arc::clone(&state.engine),
        insert: Arc::new(cluster_insert(node, index.clone())),
        index,
    };
    import_into(state, target, body, as_task).await
}
