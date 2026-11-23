mod cluster;
pub(crate) mod common;
pub(crate) mod documents;
mod indexes;
pub(crate) mod info;
mod maintenance;
pub(crate) mod search;
mod settings;
pub(crate) mod suggestions;
mod sync;
pub(crate) mod task_routes;

use std::sync::Arc;

use crate::errors::{Outcome, ServerError};
use crate::http::pipeline::RouteContext;
use crate::http::respond::HttpResponse;
use crate::http::routes::Route;
use crate::state::ServerState;

pub(crate) async fn dispatch(
    state: Arc<ServerState>,
    route: Route,
    context: RouteContext,
) -> Outcome<HttpResponse> {
    #[cfg(feature = "cluster")]
    if let Some(node) = state.cluster.clone() {
        return crate::cluster::dispatch(state, node, route, context).await;
    }
    use Route::*;
    match route {
        Livez => info::livez(),
        Readyz => info::readyz(&state),
        Version => info::version(&state),
        Capabilities => info::capabilities(),
        ClusterTopology
        | ClusterHealth
        | Metrics
        | ClusterAllocation
        | ClusterReplicationFactor
        | CreateBackup
        | ListBackups
        | RestoreBackup
        | DeleteBackup => cluster::handle(state, route, context).await,
        ListTasks | GetTask | CancelTask => task_routes::handle(state, route, context).await,
        CreateIndex | ListIndexes | DropIndex | IndexStats | IndexPartitions | ClearIndex
        | OpenIndex | CloseIndex | Count | Memory => indexes::handle(state, route, context).await,
        Insert | Batch | MultiGet | WaitForWrites | Get | Exists | Put | Patch | Remove => {
            documents::handle(state, route, context).await
        }
        Search | Preflight | Suggest | List => Err(ServerError::internal()),
        ImportNdjson
        | RebuildAnalysis
        | ChangeAnalysis
        | Optimize
        | Rebalance
        | Restore
        | ImportExport
        | BuildQuerySuggestions => maintenance::handle(state, route, context).await,
        Checkpoint | Snapshot | VectorMaintenance | Compact | PartitionConfig | ReadSynonyms
        | ReplaceSynonyms | UpdateBm25 | ExportDocuments => {
            settings::handle(state, route, context).await
        }
        GetSync | UpdateSync | SyncSnapshot | GetChanges | UpdateChanges => {
            sync::handle(state, route, context).await
        }
        UpdateQuerySuggestions
        | QuerySuggestionsStatus
        | RecordQuery
        | PreviewQuerySuggestions
        | ReadQueryBans
        | ReplaceQueryBans
        | RemoveQuery
        | AddManualSuggestion => suggestions::handle(state, route, context).await,
    }
}
