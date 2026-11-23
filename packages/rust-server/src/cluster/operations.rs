use narsil::Value;

use crate::errors::ServerError;
use crate::http::routes::Route;

const CLUSTER_OPERATION_UNSUPPORTED: &str = "CLUSTER_OPERATION_UNSUPPORTED";

pub(crate) fn unsupported(operation: &str) -> ServerError {
    ServerError::coded(
        CLUSTER_OPERATION_UNSUPPORTED,
        format!(
            "A cluster node does not serve '{operation}' yet; run it against a single-node engine"
        ),
    )
    .with_detail("operation", Value::String(operation.to_string()))
}

pub(super) fn operation_of(route: Route) -> &'static str {
    use Route::*;
    match route {
        Livez | Readyz | Version | Capabilities | ListTasks | GetTask | CancelTask => "server",
        ClusterTopology => "listNodes",
        ClusterHealth => "getHealth",
        Metrics => "getMetrics",
        Memory => "getMemoryStats",
        CreateIndex => "createIndex",
        ListIndexes => "listIndexes",
        DropIndex => "dropIndex",
        IndexStats => "getStats",
        IndexPartitions => "getPartitionStats",
        ClusterAllocation => "getAllocation",
        ClusterReplicationFactor => "setReplicationFactor",
        ClearIndex => "clear",
        OpenIndex => "open",
        CloseIndex => "close",
        Count => "countDocuments",
        Insert => "insert",
        Batch => "insertBatch",
        List => "listDocuments",
        MultiGet => "getMultiple",
        ImportNdjson => "importNdjson",
        WaitForWrites => "waitForWrites",
        Get => "get",
        Exists | Put => "has",
        Patch => "update",
        Remove => "remove",
        Search => "query",
        Preflight => "preflight",
        Suggest => "suggest",
        Checkpoint => "checkpoint",
        RebuildAnalysis => "rebuildAnalysis",
        ChangeAnalysis => "changeAnalysis",
        Snapshot => "snapshot",
        VectorMaintenance => "vectorMaintenanceStatus",
        Compact => "compactVectors",
        Optimize => "optimizeVectors",
        Rebalance => "rebalance",
        PartitionConfig => "updatePartitionConfig",
        ReadSynonyms => "getSynonyms",
        ReplaceSynonyms => "updateSynonyms",
        UpdateBm25 => "updateBM25",
        Restore => "restore",
        ExportDocuments => "exportDocuments",
        ImportExport => "importDocumentExport",
        CreateBackup => "createBackup",
        ListBackups => "listBackups",
        RestoreBackup => "restoreBackup",
        DeleteBackup => "deleteBackup",
        GetSync | SyncSnapshot => "getSync",
        UpdateSync => "updateSync",
        GetChanges => "getChanges",
        UpdateChanges => "updateChanges",
        UpdateQuerySuggestions
        | QuerySuggestionsStatus
        | RecordQuery
        | BuildQuerySuggestions
        | PreviewQuerySuggestions
        | ReadQueryBans
        | ReplaceQueryBans
        | RemoveQuery
        | AddManualSuggestion => "querySuggestions",
    }
}
