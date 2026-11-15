use narsil::{Map, NarsilError, Value};

/// The codes that the server raises itself, beside the engine's [`narsil::ErrorCode`] values, spelled as the
/// TypeScript server spells them.
pub mod server_codes {
    /// A request whose path, query, or body breaks the route's rules.
    pub const INVALID_REQUEST: &str = "INVALID_REQUEST";
    /// A body that is not one JSON value.
    pub const INVALID_JSON: &str = "INVALID_JSON";
    /// A route that needs a body received none.
    pub const EMPTY_BODY: &str = "EMPTY_BODY";
    /// A body longer than the route's byte limit.
    pub const PAYLOAD_TOO_LARGE: &str = "PAYLOAD_TOO_LARGE";
    /// A path that no route serves.
    pub const NOT_FOUND: &str = "NOT_FOUND";
    /// A task identifier that the task store does not hold.
    pub const TASK_NOT_FOUND: &str = "TASK_NOT_FOUND";
    /// A cancel request for a task that has finished or cannot stop.
    pub const TASK_NOT_CANCELLABLE: &str = "TASK_NOT_CANCELLABLE";
    /// A cancel request for a task that another server instance runs.
    pub const TASK_OWNED_BY_ANOTHER_INSTANCE: &str = "TASK_OWNED_BY_ANOTHER_INSTANCE";
    /// A task whose server stopped before it finished.
    pub const TASK_INTERRUPTED: &str = "TASK_INTERRUPTED";
    /// A request past the concurrency limit or the body budget.
    pub const TOO_MANY_REQUESTS: &str = "TOO_MANY_REQUESTS";
    /// The request check failed or returned a decision that the server cannot act on.
    pub const HOOK_ERROR: &str = "HOOK_ERROR";
    /// A failure that the server keeps from the caller.
    pub const INTERNAL_ERROR: &str = "INTERNAL_ERROR";
}

/// Returns the HTTP status that the server answers with for an error `code`, which is 500 for a code that the
/// table leaves out, so that an internal fault never reaches a caller as a client error.
pub fn http_status_for_code(code: &str) -> u16 {
    match code {
        "INVALID_REQUEST"
        | "INVALID_JSON"
        | "EMPTY_BODY"
        | "ENVELOPE_INVALID_MAGIC"
        | "ENVELOPE_VERSION_MISMATCH"
        | "SCHEMA_INVALID_TYPE"
        | "SCHEMA_DEPTH_EXCEEDED"
        | "SCHEMA_INVALID_VECTOR_DIMENSION"
        | "SCHEMA_INVALID_GEOPOINT"
        | "DOC_VALIDATION_FAILED"
        | "DOC_MISSING_REQUIRED_FIELD"
        | "SEARCH_INVALID_FIELD"
        | "VECTOR_DIMENSION_MISMATCH"
        | "SEARCH_INVALID_FILTER"
        | "SEARCH_INVALID_MODE"
        | "SEARCH_INVALID_CURSOR"
        | "SEARCH_RESULT_WINDOW_EXCEEDED"
        | "SEARCH_WORK_CAP_EXCEEDED"
        | "SEARCH_INVALID_PHRASE"
        | "LANGUAGE_NOT_SUPPORTED"
        | "CONFIG_INVALID"
        | "EMBEDDING_DIMENSION_MISMATCH"
        | "EMBEDDING_NO_SOURCE"
        | "EMBEDDING_CONFIG_INVALID"
        | "RERANK_CONFIG_INVALID"
        | "CHANGES_INVALID_POSITIONS"
        | "ALLOCATION_INVALID_CONFIG"
        | "SNAPSHOT_SYNC_REQUEST_INVALID"
        | "SNAPSHOT_SYNC_HEADER_INVALID"
        | "SNAPSHOT_SYNC_FRAME_INVALID" => 400,
        "SNAPSHOT_SYNC_UNAUTHORIZED" => 403,
        "NOT_FOUND"
        | "TASK_NOT_FOUND"
        | "INDEX_NOT_FOUND"
        | "DOC_NOT_FOUND"
        | "BACKUP_NOT_FOUND"
        | "SYNC_NOT_ENABLED"
        | "CHANGES_NOT_ENABLED"
        | "QUERY_SUGGESTIONS_NOT_ENABLED"
        | "SNAPSHOT_SYNC_INDEX_NOT_FOUND" => 404,
        "TASK_NOT_CANCELLABLE"
        | "TASK_OWNED_BY_ANOTHER_INSTANCE"
        | "INDEX_ALREADY_EXISTS"
        | "INDEX_ORPHANED"
        | "DOC_ALREADY_EXISTS"
        | "PARTITION_REBALANCING_BACKPRESSURE"
        | "PARTITION_CAPACITY_EXCEEDED"
        | "ANALYSIS_CHANGE_REPLACED"
        | "BACKUP_ALREADY_EXISTS"
        | "BACKUP_DURABILITY_REQUIRED"
        | "BACKUP_IN_PROGRESS"
        | "BACKUP_STORE_CLAIMED"
        | "SYNC_DURABILITY_REQUIRED"
        | "SYNC_BACKUP_STORE_REQUIRED"
        | "CHANGES_DURABILITY_REQUIRED"
        | "CHANGES_BACKUP_STORE_REQUIRED"
        | "CHANGES_PREVIOUS_DOCUMENT_REQUIRED"
        | "REPLICATION_WRITE_CONFLICT"
        | "NODE_ALREADY_JOINED"
        | "NODE_VERSION_INCOMPATIBLE"
        | "SNAPSHOT_SYNC_ABORTED" => 409,
        "PAYLOAD_TOO_LARGE" | "SNAPSHOT_SYNC_CHUNK_SIZE_EXCEEDED" => 413,
        "BACKUP_DAMAGED" => 422,
        "TOO_MANY_REQUESTS" | "MEMORY_WRITE_BLOCKED" | "WORKER_BUSY" | "CLUSTER_WRITE_BLOCKED" => {
            429
        }
        "BACKUP_STORE_NOT_CONFIGURED" | "CLUSTER_OPERATION_UNSUPPORTED" => 501,
        "COORDINATOR_AUTH_FAILED" => 502,
        "TASK_INTERRUPTED"
        | "SEARCH_PHRASE_NOT_READY"
        | "INDEX_REOPEN_CAPACITY_EXHAUSTED"
        | "INSTANCE_SHUT_DOWN"
        | "ANALYSIS_CHANGE_NOT_READY"
        | "ANALYSIS_GENERATION_MISSING"
        | "PARTITION_CORRUPTED"
        | "WORKER_CRASHED"
        | "WORKER_TIMEOUT"
        | "PERSISTENCE_SAVE_FAILED"
        | "PERSISTENCE_LOAD_FAILED"
        | "PERSISTENCE_DELETE_FAILED"
        | "PERSISTENCE_CRC_MISMATCH"
        | "PERSISTENCE_WAL_CORRUPT"
        | "PERSISTENCE_FSYNC_FAILED"
        | "BACKUP_NOT_READY"
        | "SYNC_NOT_READY"
        | "SYNC_SNAPSHOT_PREPARING"
        | "CHANGES_NOT_READY"
        | "CHANGES_EXPORT_PREPARING"
        | "EMBEDDING_FAILED"
        | "RERANK_FAILED"
        | "QUERY_ROUTING_FAILED"
        | "BM25_NOT_READY"
        | "QUERY_PARTIAL_FAILURE"
        | "QUERY_NODE_TIMEOUT"
        | "QUERY_NO_ACTIVE_REPLICA"
        | "SEARCH_CONTEXT_MISSING"
        | "REPLICATION_ENTRY_INVALID"
        | "REPLICATION_INSYNC_REMOVAL_FAILED"
        | "REPLICATION_ROLLBACK_FAILED"
        | "REPLICATION_OUTCOME_UNKNOWN"
        | "REPLICATION_LOG_FULL"
        | "REPLICATION_ENTRY_CORRUPT"
        | "REPLICATION_SNAPSHOT_CORRUPT"
        | "REPLICATION_TERM_MISMATCH"
        | "REPLICATION_SYNC_FAILED"
        | "PARTITION_NOT_PRIMARY"
        | "PARTITION_UNASSIGNED"
        | "INSUFFICIENT_REPLICAS"
        | "ALLOCATION_NO_DATA_NODES"
        | "ALLOCATION_FAILED"
        | "NODE_NOT_JOINED"
        | "NODE_NOT_READY"
        | "NODE_NOT_CONTROLLER"
        | "NODE_BOOTSTRAP_FAILED"
        | "COORDINATOR_UNAVAILABLE"
        | "SNAPSHOT_SYNC_CAPACITY_EXHAUSTED"
        | "SNAPSHOT_SYNC_SNAPSHOT_FAILED"
        | "SNAPSHOT_SYNC_DECODE_FAILED"
        | "SNAPSHOT_SYNC_HEADER_MISMATCH"
        | "SNAPSHOT_SYNC_CHUNK_OUT_OF_ORDER"
        | "SNAPSHOT_SYNC_CHUNK_OVERFLOW"
        | "SNAPSHOT_SYNC_CHUNK_MISSING"
        | "SNAPSHOT_SYNC_END_MISSING"
        | "SNAPSHOT_SYNC_CHECKSUM_MISMATCH"
        | "SNAPSHOT_SYNC_PRIMARY_ERROR"
        | "SNAPSHOT_SYNC_NO_TARGETS"
        | "SNAPSHOT_SYNC_TRANSPORT_FAILED"
        | "SNAPSHOT_SYNC_SCHEMA_UNAVAILABLE"
        | "SNAPSHOT_SYNC_RESTORE_FAILED"
        | "SNAPSHOT_SYNC_RESTORE_CLEANUP_FAILED"
        | "SNAPSHOT_SYNC_TIMEOUT"
        | "SNAPSHOT_SYNC_ALLOCATION_UNAVAILABLE"
        | "SNAPSHOT_SYNC_NOT_ASSIGNED" => 503,
        "RESTORE_MEMORY_EXCEEDED" | "ANALYSIS_REBUILD_MEMORY_EXCEEDED" => 507,
        _ => 500,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ServerError {
    pub(crate) status: u16,
    pub(crate) code: String,
    pub(crate) message: String,
    pub(crate) details: Option<Map>,
    pub(crate) headers: Vec<(&'static str, String)>,
}

impl ServerError {
    pub(crate) fn new(status: u16, code: &str, message: impl Into<String>) -> ServerError {
        ServerError {
            status,
            code: code.to_string(),
            message: message.into(),
            details: None,
            headers: Vec::new(),
        }
    }

    pub(crate) fn coded(code: &str, message: impl Into<String>) -> ServerError {
        ServerError::new(http_status_for_code(code), code, message)
    }

    pub(crate) fn invalid(message: impl Into<String>) -> ServerError {
        ServerError::new(400, server_codes::INVALID_REQUEST, message)
    }

    pub(crate) fn internal() -> ServerError {
        ServerError::new(
            500,
            server_codes::INTERNAL_ERROR,
            "An unexpected error occurred",
        )
    }

    pub(crate) fn with_details(mut self, details: Map) -> ServerError {
        self.details = if details.is_empty() {
            None
        } else {
            Some(details)
        };
        self
    }

    pub(crate) fn with_detail(mut self, key: &str, value: Value) -> ServerError {
        self.details.get_or_insert_with(Map::new).insert(key, value);
        self
    }

    pub(crate) fn with_header(mut self, name: &'static str, value: String) -> ServerError {
        self.headers.push((name, value));
        self
    }

    pub(crate) fn envelope(&self) -> Value {
        let mut error = Map::new();
        error.insert("code", Value::String(self.code.clone()));
        error.insert("message", Value::String(self.message.clone()));
        if let Some(details) = &self.details {
            error.insert("details", Value::Object(details.clone()));
        }
        let mut envelope = Map::new();
        envelope.insert("error", Value::Object(error));
        Value::Object(envelope)
    }
}

impl From<NarsilError> for ServerError {
    fn from(error: NarsilError) -> ServerError {
        let mut converted = ServerError::coded(error.code().as_str(), error.message());
        if let Some(details) = error.details() {
            converted.details = Some(details.clone());
        }
        converted
    }
}

pub(crate) type Outcome<T> = Result<T, ServerError>;
