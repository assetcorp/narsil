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
    /// again.
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
