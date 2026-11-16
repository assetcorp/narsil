use http::Method;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Route {
    Livez,
    Readyz,
    Version,
    Capabilities,
    ClusterTopology,
    ClusterHealth,
    Metrics,
    Memory,
    ListTasks,
    GetTask,
    CancelTask,
    CreateIndex,
    ListIndexes,
    DropIndex,
    IndexStats,
    IndexPartitions,
    ClusterAllocation,
    ClusterReplicationFactor,
    ClearIndex,
    OpenIndex,
    CloseIndex,
    Count,
    Insert,
    Batch,
    List,
    MultiGet,
    ImportNdjson,
    WaitForWrites,
    Get,
    Exists,
    Put,
    Patch,
    Remove,
    Search,
    Preflight,
    Suggest,
    Checkpoint,
    RebuildAnalysis,
    ChangeAnalysis,
    Snapshot,
    VectorMaintenance,
    Compact,
    Optimize,
    Rebalance,
    PartitionConfig,
    ReadSynonyms,
    ReplaceSynonyms,
    UpdateBm25,
    Restore,
    ExportDocuments,
    ImportExport,
    CreateBackup,
    ListBackups,
    RestoreBackup,
    DeleteBackup,
    GetSync,
    UpdateSync,
    SyncSnapshot,
    GetChanges,
    UpdateChanges,
    UpdateQuerySuggestions,
    QuerySuggestionsStatus,
    RecordQuery,
    BuildQuerySuggestions,
    PreviewQuerySuggestions,
    ReadQueryBans,
    ReplaceQueryBans,
    RemoveQuery,
    AddManualSuggestion,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BodyRule {
    Ignored,
    Json,
    Import,
    Spooled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RouteOptions {
    pub(crate) body: BodyRule,
    pub(crate) skip_hooks: bool,
    pub(crate) captures_context: bool,
    pub(crate) on_query_threads: bool,
}

const PROBE: RouteOptions = RouteOptions {
    body: BodyRule::Ignored,
    skip_hooks: true,
    captures_context: false,
    on_query_threads: false,
};
const BARE: RouteOptions = RouteOptions {
    body: BodyRule::Ignored,
    skip_hooks: false,
    captures_context: false,
    on_query_threads: false,
};
const JSON_BODY: RouteOptions = RouteOptions {
    body: BodyRule::Json,
    skip_hooks: false,
    captures_context: false,
    on_query_threads: false,
};
const QUERY_BODY: RouteOptions = RouteOptions {
    body: BodyRule::Json,
    skip_hooks: false,
    captures_context: false,
    on_query_threads: true,
};
const IMPORT_BODY: RouteOptions = RouteOptions {
    body: BodyRule::Import,
    skip_hooks: false,
    captures_context: false,
    on_query_threads: false,
};
const SPOOLED_BODY: RouteOptions = RouteOptions {
    body: BodyRule::Spooled,
    skip_hooks: false,
    captures_context: false,
    on_query_threads: false,
};
const CONTEXT_BODY: RouteOptions = RouteOptions {
    body: BodyRule::Json,
    skip_hooks: false,
    captures_context: true,
    on_query_threads: false,
};

pub(crate) struct RouteEntry {
    pub(crate) method: Method,
    pub(crate) pattern: &'static str,
    pub(crate) route: Route,
    pub(crate) options: RouteOptions,
}

macro_rules! entries {
    ($($method:ident $pattern:literal $route:ident $options:ident),* $(,)?) => {
        &[$(RouteEntry {
            method: Method::$method,
            pattern: $pattern,
            route: Route::$route,
            options: $options,
        }),*]
    };
}

pub(crate) const ROUTES: &[RouteEntry] = entries![
    GET "/livez" Livez PROBE,
    GET "/readyz" Readyz PROBE,
    GET "/health" Readyz PROBE,
    GET "/version" Version PROBE,
    GET "/capabilities" Capabilities BARE,
    GET "/cluster" ClusterTopology BARE,
    GET "/cluster/health" ClusterHealth BARE,
    GET "/metrics" Metrics BARE,
    GET "/stats/memory" Memory BARE,
    GET "/tasks" ListTasks BARE,
    GET "/tasks/:id" GetTask BARE,
    POST "/tasks/:id/_cancel" CancelTask BARE,
    POST "/indexes" CreateIndex JSON_BODY,
    GET "/indexes" ListIndexes BARE,
    DELETE "/indexes/:name" DropIndex BARE,
    GET "/indexes/:name/stats" IndexStats BARE,
    GET "/indexes/:name/partitions" IndexPartitions BARE,
    GET "/indexes/:name/cluster" ClusterAllocation BARE,
    PUT "/indexes/:name/replication-factor" ClusterReplicationFactor JSON_BODY,
    POST "/indexes/:name/_clear" ClearIndex BARE,
    POST "/indexes/:name/_open" OpenIndex BARE,
    POST "/indexes/:name/_close" CloseIndex BARE,
    GET "/indexes/:name/count" Count BARE,
    POST "/indexes/:name/documents" Insert JSON_BODY,
    POST "/indexes/:name/documents/_batch" Batch JSON_BODY,
    POST "/indexes/:name/documents/_list" List QUERY_BODY,
    POST "/indexes/:name/documents/_multi-get" MultiGet JSON_BODY,
    POST "/indexes/:name/documents/_import" ImportNdjson IMPORT_BODY,
    POST "/indexes/:name/_wait-for-writes" WaitForWrites BARE,
    GET "/indexes/:name/documents/:id" Get BARE,
    GET "/indexes/:name/documents/:id/_exists" Exists BARE,
    PUT "/indexes/:name/documents/:id" Put JSON_BODY,
    PATCH "/indexes/:name/documents/:id" Patch JSON_BODY,
    DELETE "/indexes/:name/documents/:id" Remove BARE,
    POST "/indexes/:name/search" Search QUERY_BODY,
    POST "/indexes/:name/search/preflight" Preflight QUERY_BODY,
    POST "/indexes/:name/suggest" Suggest QUERY_BODY,
    POST "/indexes/:name/_checkpoint" Checkpoint BARE,
    POST "/indexes/:name/_rebuild-analysis" RebuildAnalysis BARE,
    POST "/indexes/:name/_change-analysis" ChangeAnalysis JSON_BODY,
    GET "/indexes/:name/snapshot" Snapshot BARE,
    GET "/indexes/:name/vector-maintenance" VectorMaintenance BARE,
    POST "/indexes/:name/vectors/_compact" Compact JSON_BODY,
    POST "/indexes/:name/vectors/_optimize" Optimize JSON_BODY,
    POST "/indexes/:name/_rebalance" Rebalance JSON_BODY,
    POST "/indexes/:name/partition-config" PartitionConfig JSON_BODY,
    GET "/indexes/:name/synonyms" ReadSynonyms BARE,
    POST "/indexes/:name/synonyms" ReplaceSynonyms JSON_BODY,
    POST "/indexes/:name/bm25" UpdateBm25 JSON_BODY,
    POST "/indexes/:name/restore" Restore SPOOLED_BODY,
    GET "/indexes/:name/export" ExportDocuments BARE,
    POST "/indexes/:name/import" ImportExport SPOOLED_BODY,
    POST "/indexes/:name/backups" CreateBackup JSON_BODY,
    GET "/backups" ListBackups BARE,
    POST "/backups/:backup/_restore" RestoreBackup JSON_BODY,
    DELETE "/backups/:backup" DeleteBackup BARE,
    GET "/indexes/:name/sync" GetSync BARE,
    PUT "/indexes/:name/sync" UpdateSync JSON_BODY,
    GET "/indexes/:name/sync/snapshot" SyncSnapshot BARE,
    GET "/indexes/:name/changes" GetChanges BARE,
    PUT "/indexes/:name/changes" UpdateChanges JSON_BODY,
    PUT "/indexes/:name/query-suggestions" UpdateQuerySuggestions JSON_BODY,
    GET "/indexes/:name/query-suggestions" QuerySuggestionsStatus BARE,
    POST "/indexes/:name/query-suggestions/record" RecordQuery CONTEXT_BODY,
    POST "/indexes/:name/query-suggestions/build" BuildQuerySuggestions BARE,
    GET "/indexes/:name/query-suggestions/preview" PreviewQuerySuggestions BARE,
    GET "/indexes/:name/query-suggestions/bans" ReadQueryBans BARE,
    PUT "/indexes/:name/query-suggestions/bans" ReplaceQueryBans JSON_BODY,
    POST "/indexes/:name/query-suggestions/remove" RemoveQuery JSON_BODY,
    POST "/indexes/:name/query-suggestions/manual" AddManualSuggestion JSON_BODY,
];

pub(crate) struct Matched<'a> {
    pub(crate) entry: &'static RouteEntry,
    pub(crate) raw_params: Vec<&'a str>,
}

fn segments_match<'a>(pattern: &'static str, path: &'a str) -> Option<(Vec<&'a str>, Vec<bool>)> {
    let wanted = pattern.split('/');
    let given = path.split('/');
    let mut params = Vec::new();
    let mut literals = Vec::new();
    let mut wanted = wanted.peekable();
    let mut given = given.peekable();
    loop {
        match (wanted.next(), given.next()) {
            (None, None) => return Some((params, literals)),
            (Some(expected), Some(segment)) if expected.starts_with(':') => {
                params.push(segment);
                literals.push(false);
            }
            (Some(expected), Some(segment)) if expected == segment => literals.push(true),
            _ => return None,
        }
    }
}

pub(crate) fn match_route<'a>(method: &Method, path: &'a str) -> Option<Matched<'a>> {
    let mut best: Option<(Matched<'a>, Vec<bool>)> = None;
    for entry in ROUTES.iter().filter(|entry| entry.method == *method) {
        let Some((raw_params, literals)) = segments_match(entry.pattern, path) else {
            continue;
        };
        let better = match &best {
            None => true,
            Some((_, held)) => literals > *held,
        };
        if better {
            best = Some((Matched { entry, raw_params }, literals));
        }
    }
    best.map(|(matched, _)| matched)
}
