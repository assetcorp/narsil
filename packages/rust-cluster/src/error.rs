use std::fmt;

use narsil::{Map, NarsilError, Value};

/// The error codes that a cluster node raises and sends, spelled as `packages/spec/distribution` spells them.
pub mod codes {
    /// The sender could not hand the message to the peer, so the peer never received it.
    pub const TRANSPORT_CONNECT_FAILED: &str = "TRANSPORT_CONNECT_FAILED";
    /// A request did not finish within its timeout.
    pub const TRANSPORT_TIMEOUT: &str = "TRANSPORT_TIMEOUT";
    /// A message passed the 67,108,864-byte limit.
    pub const TRANSPORT_MESSAGE_TOO_LARGE: &str = "TRANSPORT_MESSAGE_TOO_LARGE";
    /// A received message is not valid MessagePack, or breaks the shape of its envelope.
    pub const TRANSPORT_DECODE_FAILED: &str = "TRANSPORT_DECODE_FAILED";
    /// The connection failed after the sender handed the message over, so the peer may have acted on it.
    pub const TRANSPORT_PEER_UNAVAILABLE: &str = "TRANSPORT_PEER_UNAVAILABLE";
    /// A message reached a node that has yet to finish joining the cluster.
    pub const NODE_NOT_READY: &str = "NODE_NOT_READY";
    /// A setting or a request payload breaks its rules.
    pub const CONFIG_INVALID: &str = "CONFIG_INVALID";
    /// A failure that the node keeps from the sender.
    pub const INTERNAL_ERROR: &str = "INTERNAL_ERROR";
    /// The node cannot read or store its id in its durability directory.
    pub const PERSISTENCE_SAVE_FAILED: &str = "PERSISTENCE_SAVE_FAILED";
    /// The coordinator reached no etcd endpoint, or completed no TLS handshake with one.
    pub const COORDINATOR_UNAVAILABLE: &str = "COORDINATOR_UNAVAILABLE";
    /// etcd refused the user or the password that the coordinator signed in with.
    pub const COORDINATOR_AUTH_FAILED: &str = "COORDINATOR_AUTH_FAILED";
    /// A controller message reached a node that holds no controller lease.
    pub const NODE_NOT_CONTROLLER: &str = "NODE_NOT_CONTROLLER";
    /// A node follows a specification version whose major version differs from the active controller's.
    pub const NODE_VERSION_INCOMPATIBLE: &str = "NODE_VERSION_INCOMPATIBLE";
    /// A node stopped while it waited for its earlier registration to lapse, or a node that shut down was started
    /// again or asked for an operation on its copies.
    pub const NODE_NOT_JOINED: &str = "NODE_NOT_JOINED";
    /// A node that has joined the cluster, or is joining it, was started again.
    pub const NODE_ALREADY_JOINED: &str = "NODE_ALREADY_JOINED";
    /// The controller of this node cannot run the operation that a request asks for.
    pub const CLUSTER_OPERATION_UNSUPPORTED: &str = "CLUSTER_OPERATION_UNSUPPORTED";
    /// The stored metadata of an index breaks its rules.
    pub const CONTROLLER_METADATA_INVALID: &str = "CONTROLLER_METADATA_INVALID";
    /// The allocator was given a partition count or a replication factor outside its range.
    pub const ALLOCATION_INVALID_CONFIG: &str = "ALLOCATION_INVALID_CONFIG";
    /// The allocator found no node that holds the data role.
    pub const ALLOCATION_NO_DATA_NODES: &str = "ALLOCATION_NO_DATA_NODES";
    /// The controller could not place a partition or write an allocation table.
    pub const ALLOCATION_FAILED: &str = "ALLOCATION_FAILED";
    /// An index is changing its partition count, so a second change or an analysis change must wait for it.
    pub const PARTITION_REBALANCING_BACKPRESSURE: &str = "PARTITION_REBALANCING_BACKPRESSURE";
    /// An entry exceeds what the replication log can hold.
    pub const REPLICATION_LOG_FULL: &str = "REPLICATION_LOG_FULL";
    /// A replication log entry failed its checksum.
    pub const REPLICATION_ENTRY_CORRUPT: &str = "REPLICATION_ENTRY_CORRUPT";
    /// A replication message is malformed, out of order, or sent to a node that holds no replica of the partition.
    pub const REPLICATION_ENTRY_INVALID: &str = "REPLICATION_ENTRY_INVALID";
    /// A replica received a message of a term older than one that it knows.
    pub const REPLICATION_TERM_MISMATCH: &str = "REPLICATION_TERM_MISMATCH";
    /// A sync could not finish, or a report belongs to a sync that is no longer the replica's current one.
    pub const REPLICATION_SYNC_FAILED: &str = "REPLICATION_SYNC_FAILED";
    /// A write failed, and the primary could not put back what it held before the write.
    pub const REPLICATION_ROLLBACK_FAILED: &str = "REPLICATION_ROLLBACK_FAILED";
    /// A write may or may not have taken effect, for the reason that the error's details give.
    pub const REPLICATION_OUTCOME_UNKNOWN: &str = "REPLICATION_OUTCOME_UNKNOWN";
    /// A write that was sent again after its term ended met a later write to the same document, so it took no effect.
    pub const REPLICATION_WRITE_CONFLICT: &str = "REPLICATION_WRITE_CONFLICT";
    /// The primary could not remove a failed replica from the in-sync set while it held its term.
    pub const REPLICATION_INSYNC_REMOVAL_FAILED: &str = "REPLICATION_INSYNC_REMOVAL_FAILED";
    /// A write reached a node that is not the primary of the write's partition.
    pub const PARTITION_NOT_PRIMARY: &str = "PARTITION_NOT_PRIMARY";
    /// The write's partition has no primary.
    pub const PARTITION_UNASSIGNED: &str = "PARTITION_UNASSIGNED";
    /// Fewer copies are active than `waitForActiveReplicas` asks for.
    pub const INSUFFICIENT_REPLICAS: &str = "INSUFFICIENT_REPLICAS";
    /// The node holds no copy of the index that a request gives.
    pub const INDEX_NOT_FOUND: &str = "INDEX_NOT_FOUND";
    /// The cluster holds an index under that name, or a create of that name is pending.
    pub const INDEX_ALREADY_EXISTS: &str = "INDEX_ALREADY_EXISTS";
    /// A registered node runs a specification version below 1.1, so it cannot use the BM25 parameters that an index
    /// sets.
    pub const BM25_NOT_READY: &str = "BM25_NOT_READY";
    /// A node reports an orphaned copy, or a caller sends that node a read, a write, or a create for the copy's index
    /// name.
    pub const INDEX_ORPHANED: &str = "INDEX_ORPHANED";
    /// A node refuses an insert or an update because a node that holds a copy of the index reports full memory,
    /// because the writes in flight on the node would pass its bound, or because the write would not fit in memory.
    pub const CLUSTER_WRITE_BLOCKED: &str = "CLUSTER_WRITE_BLOCKED";
    /// Device sync would go on, or a feed would read a log, through a node that keeps no write-ahead log.
    pub const SYNC_DURABILITY_REQUIRED: &str = "SYNC_DURABILITY_REQUIRED";
    /// Device sync would go on through a node that has no backup store.
    pub const SYNC_BACKUP_STORE_REQUIRED: &str = "SYNC_BACKUP_STORE_REQUIRED";
    /// Device sync would go on while a registered node follows a specification version below 1.3.
    pub const SYNC_NOT_READY: &str = "SYNC_NOT_READY";
    /// Change capture would go on through a node that keeps no write-ahead log.
    pub const CHANGES_DURABILITY_REQUIRED: &str = "CHANGES_DURABILITY_REQUIRED";
    /// Change capture would go on through a node that has no backup store.
    pub const CHANGES_BACKUP_STORE_REQUIRED: &str = "CHANGES_BACKUP_STORE_REQUIRED";
    /// Change capture would go on while a registered node follows a specification version below 1.5.
    pub const CHANGES_NOT_READY: &str = "CHANGES_NOT_READY";
    /// The cluster owns the index and has yet to allocate it.
    pub const QUERY_ROUTING_FAILED: &str = "QUERY_ROUTING_FAILED";
    /// No node that holds the copy could take the request, because the transport could not reach it.
    pub const QUERY_NO_ACTIVE_REPLICA: &str = "QUERY_NO_ACTIVE_REPLICA";
    /// The node that holds the copy did not answer within the transport's deadline.
    pub const QUERY_NODE_TIMEOUT: &str = "QUERY_NODE_TIMEOUT";
    /// The data node holds another analysis generation of the index than the query asked for.
    pub const ANALYSIS_GENERATION_MISSING: &str = "ANALYSIS_GENERATION_MISSING";
    /// The data node holds no search context under the id that a fetch names.
    pub const SEARCH_CONTEXT_MISSING: &str = "SEARCH_CONTEXT_MISSING";
    /// A query names a field that the request cannot search, sort, or return.
    pub const SEARCH_INVALID_FIELD: &str = "SEARCH_INVALID_FIELD";
    /// A query asks for a sort direction, sort mode, scoring mode, or search mode that no engine knows.
    pub const SEARCH_INVALID_MODE: &str = "SEARCH_INVALID_MODE";
    /// A document or a document id breaks the rules that every Narsil engine stores documents under.
    pub const DOC_VALIDATION_FAILED: &str = "DOC_VALIDATION_FAILED";
    /// An insert names a document id that the index holds.
    pub const DOC_ALREADY_EXISTS: &str = "DOC_ALREADY_EXISTS";
    /// A sync request is malformed, or its term is above the primary's.
    pub const SNAPSHOT_SYNC_REQUEST_INVALID: &str = "SNAPSHOT_SYNC_REQUEST_INVALID";
    /// The primary could not read the allocation table for a sync.
    pub const SNAPSHOT_SYNC_ALLOCATION_UNAVAILABLE: &str = "SNAPSHOT_SYNC_ALLOCATION_UNAVAILABLE";
    /// A sync request came from a node that holds no copy, or reached a node that is not the partition's primary.
    pub const SNAPSHOT_SYNC_UNAUTHORIZED: &str = "SNAPSHOT_SYNC_UNAUTHORIZED";
    /// A sync request gives a partition without an assignment, or copies in a state that takes no sync.
    pub const SNAPSHOT_SYNC_NOT_ASSIGNED: &str = "SNAPSHOT_SYNC_NOT_ASSIGNED";
    /// The primary holds no copy of the index that a sync request gives.
    pub const SNAPSHOT_SYNC_INDEX_NOT_FOUND: &str = "SNAPSHOT_SYNC_INDEX_NOT_FOUND";
    /// The primary sends as many snapshots as its limits allow.
    pub const SNAPSHOT_SYNC_CAPACITY_EXHAUSTED: &str = "SNAPSHOT_SYNC_CAPACITY_EXHAUSTED";
    /// The primary could not send the snapshot that a replica needs.
    pub const SNAPSHOT_SYNC_SNAPSHOT_FAILED: &str = "SNAPSHOT_SYNC_SNAPSHOT_FAILED";
    /// A replica could not read the index's schema for a sync, or found none.
    pub const SNAPSHOT_SYNC_SCHEMA_UNAVAILABLE: &str = "SNAPSHOT_SYNC_SCHEMA_UNAVAILABLE";
    /// A replica could not resolve an address of the partition's primary.
    pub const SNAPSHOT_SYNC_NO_TARGETS: &str = "SNAPSHOT_SYNC_NO_TARGETS";
    /// A sync request or the report of a synced position failed in transport, or the primary answered that report
    /// with a snapshot.
    pub const SNAPSHOT_SYNC_TRANSPORT_FAILED: &str = "SNAPSHOT_SYNC_TRANSPORT_FAILED";
    /// A sync passed its deadline, or no time remained to report the synced position.
    pub const SNAPSHOT_SYNC_TIMEOUT: &str = "SNAPSHOT_SYNC_TIMEOUT";
    /// A payload of the primary's answer to a sync request is not valid MessagePack.
    pub const SNAPSHOT_SYNC_DECODE_FAILED: &str = "SNAPSHOT_SYNC_DECODE_FAILED";
    /// A payload of the primary's answer to a sync request breaks the answer's shape or order.
    pub const SNAPSHOT_SYNC_FRAME_INVALID: &str = "SNAPSHOT_SYNC_FRAME_INVALID";
    /// The primary's answer to a sync request ended with no sync payload, or with fewer snapshot bytes than the
    /// snapshot's `totalBytes`.
    pub const SNAPSHOT_SYNC_CHUNK_MISSING: &str = "SNAPSHOT_SYNC_CHUNK_MISSING";
    /// The first snapshot payload of a sync answer is not a valid `replication.snapshot_start`.
    pub const SNAPSHOT_SYNC_HEADER_INVALID: &str = "SNAPSHOT_SYNC_HEADER_INVALID";
    /// A snapshot payload names another index or partition than the sync asked for, or another total than its start.
    pub const SNAPSHOT_SYNC_HEADER_MISMATCH: &str = "SNAPSHOT_SYNC_HEADER_MISMATCH";
    /// A snapshot chunk does not start where the chunk before it ended.
    pub const SNAPSHOT_SYNC_CHUNK_OUT_OF_ORDER: &str = "SNAPSHOT_SYNC_CHUNK_OUT_OF_ORDER";
    /// A snapshot chunk would carry the archive past the snapshot's `totalBytes`.
    pub const SNAPSHOT_SYNC_CHUNK_OVERFLOW: &str = "SNAPSHOT_SYNC_CHUNK_OVERFLOW";
    /// A snapshot chunk holds more than 65,536 bytes.
    pub const SNAPSHOT_SYNC_CHUNK_SIZE_EXCEEDED: &str = "SNAPSHOT_SYNC_CHUNK_SIZE_EXCEEDED";
    /// A sync answer that started a snapshot ended without its `replication.snapshot_end`.
    pub const SNAPSHOT_SYNC_END_MISSING: &str = "SNAPSHOT_SYNC_END_MISSING";
    /// The snapshot's bytes, or its end payload, carry another checksum than its header.
    pub const SNAPSHOT_SYNC_CHECKSUM_MISMATCH: &str = "SNAPSHOT_SYNC_CHECKSUM_MISMATCH";
    /// The primary answered a sync request with an error reply, whose code and message the details carry as
    /// `primaryCode` and `primaryMessage`.
    pub const SNAPSHOT_SYNC_PRIMARY_ERROR: &str = "SNAPSHOT_SYNC_PRIMARY_ERROR";
    /// A node holds a copy whose schema disagrees with the schema that the cluster stores for the index, or it could
    /// not drop a copy that the cluster took away from it.
    pub const SNAPSHOT_SYNC_RESTORE_FAILED: &str = "SNAPSHOT_SYNC_RESTORE_FAILED";
    /// A node could not bring its copy of a partition into service, or could not report that it did, and the
    /// details carry the cause's code as `innerCode` where the cause has one.
    pub const NODE_BOOTSTRAP_FAILED: &str = "NODE_BOOTSTRAP_FAILED";
    /// A node started without its copy of a partition that the allocation table gives it as primary or as an
    /// in-sync replica, so it waits to register until the controller fails that copy over.
    pub const NODE_COPY_MISSING: &str = "NODE_COPY_MISSING";
    /// A second copy of an index's terms would pass the node's memory limit, so the node cannot build the analysis
    /// that a change asks for.
    pub const ANALYSIS_REBUILD_MEMORY_EXCEEDED: &str = "ANALYSIS_REBUILD_MEMORY_EXCEEDED";
    /// An analysis change names a language that the node has not registered.
    pub const LANGUAGE_NOT_SUPPORTED: &str = "LANGUAGE_NOT_SUPPORTED";
    /// A later analysis change, or a restore, replaced the analysis change that a request asks about.
    pub const ANALYSIS_CHANGE_REPLACED: &str = "ANALYSIS_CHANGE_REPLACED";
    /// The cluster has a node below the specification version that changes analysis, so the index keeps its
    /// settings until that node is upgraded.
    pub const ANALYSIS_CHANGE_NOT_READY: &str = "ANALYSIS_CHANGE_NOT_READY";
}

/// A failure of a cluster node, a transport, or a coordinator, with the code that a peer or a caller branches on.
#[derive(Debug, Clone, PartialEq)]
pub struct ClusterError {
    code: String,
    message: String,
    details: Map,
}

impl ClusterError {
    /// Returns an error with `code` and `message` and no details.
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> ClusterError {
        ClusterError {
            code: code.into(),
            message: message.into(),
            details: Map::new(),
        }
    }

    /// Returns this error with `value` stored under `key` in its details.
    pub fn with_detail(mut self, key: &str, value: Value) -> ClusterError {
        self.details.insert(key, value);
        self
    }

    /// Returns the code, such as `TRANSPORT_TIMEOUT`.
    pub fn code(&self) -> &str {
        &self.code
    }

    /// Returns the message, which can change between releases.
    pub fn message(&self) -> &str {
        &self.message
    }

    /// Returns the details, which are empty where the error carries none.
    pub fn details(&self) -> &Map {
        &self.details
    }
}

impl fmt::Display for ClusterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ClusterError {}

impl From<NarsilError> for ClusterError {
    fn from(error: NarsilError) -> ClusterError {
        ClusterError {
            code: error.code().as_str().to_string(),
            message: error.message().to_string(),
            details: error.details().cloned().unwrap_or_default(),
        }
    }
}

/// The result of a cluster operation.
pub type ClusterResult<T> = Result<T, ClusterError>;
