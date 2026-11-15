mod cluster;
pub(crate) mod common;
mod documents;
mod indexes;
mod info;
mod maintenance;
mod search;
mod suggestions;
mod sync;
mod task_routes;

use std::sync::Arc;

use crate::errors::Outcome;
use crate::http::pipeline::RouteContext;
use crate::http::respond::HttpResponse;
use crate::http::routes::Route;
use crate::state::ServerState;

pub(crate) async fn dispatch(
    state: Arc<ServerState>,
    route: Route,
    context: RouteContext,
) -> Outcome<HttpResponse> {
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
        Insert | Batch | List | MultiGet | ImportNdjson | WaitForWrites | Get | Exists | Put
        | Patch | Remove => documents::handle(state, route, context).await,
        Search | Preflight | Suggest => search::handle(state, route, context).await,
        Checkpoint | RebuildAnalysis | ChangeAnalysis | Snapshot | VectorMaintenance | Compact
        | Optimize | Rebalance | PartitionConfig | ReadSynonyms | ReplaceSynonyms | UpdateBm25
        | Restore | ExportDocuments | ImportExport => {
            maintenance::handle(state, route, context).await
        }
        GetSync | UpdateSync | SyncSnapshot | GetChanges | UpdateChanges => {
            sync::handle(state, route, context).await
        }
        UpdateQuerySuggestions
        | QuerySuggestionsStatus
        | RecordQuery
        | BuildQuerySuggestions
        | PreviewQuerySuggestions
        | ReadQueryBans
        | ReplaceQueryBans
        | RemoveQuery
        | AddManualSuggestion => suggestions::handle(state, route, context).await,
    }
}
