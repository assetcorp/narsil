use narsil::{Map, Value};

use crate::constants::{DEFAULT_CAPACITY_CPU_CORES, DEFAULT_CAPACITY_MEMORY_BYTES};
use crate::error::{ClusterError, ClusterResult, codes};

/// How much a node offers the cluster, as its registration states it.
#[derive(Debug, Clone, PartialEq)]
pub struct NodeCapacity {
    /// The memory that the node offers, in bytes.
    pub memory_bytes: f64,
    /// The processor cores that the node offers.
    pub cpu_cores: f64,
    /// The disk space that the node offers, in bytes, where it states any.
    pub disk_bytes: Option<f64>,
}

impl Default for NodeCapacity {
    fn default() -> NodeCapacity {
        NodeCapacity {
            memory_bytes: DEFAULT_CAPACITY_MEMORY_BYTES as f64,
            cpu_cores: DEFAULT_CAPACITY_CPU_CORES as f64,
            disk_bytes: None,
        }
    }
}

/// The record that a node writes under its lease in etcd, which names the node and states how a peer reaches it.
#[derive(Debug, Clone, PartialEq)]
pub struct NodeRegistration {
    /// The node's id.
    pub node_id: String,
    /// The `host:port` address that a peer's transport dials.
    pub address: String,
    /// The roles that the node holds, from `data`, `coordinator`, and `controller`.
    pub roles: Vec<String>,
    /// What the node offers the cluster.
    pub capacity: NodeCapacity,
    /// When this registration's process started, in the ISO 8601 form of JavaScript's `toISOString`.
    pub started_at: String,
    /// The specification version that the node speaks.
    pub version: String,
    /// Every other field of the record, such as `metadata`, `memory`, `partitionBytes`, and `draining`, in the
    /// order that the record holds them. A field that the record stores as nil is absent here, as a missing field is.
    pub extra: Map,
}

/// The lifecycle state of one partition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PartitionState {
    /// No node holds the partition.
    Unassigned,
    /// A node is building its copy of the partition.
    Initialising,
    /// The partition serves reads and writes.
    Active,
    /// The partition is moving to another node.
    Migrating,
    /// The partition is leaving its node.
    Decommissioning,
}

impl PartitionState {
    /// Returns the state as etcd stores it.
    pub fn as_str(self) -> &'static str {
        match self {
            PartitionState::Unassigned => "UNASSIGNED",
            PartitionState::Initialising => "INITIALISING",
            PartitionState::Active => "ACTIVE",
            PartitionState::Migrating => "MIGRATING",
            PartitionState::Decommissioning => "DECOMMISSIONING",
        }
    }

    /// Returns the state that `text` spells.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` where `text` spells no state.
    pub fn parse(text: &str) -> ClusterResult<PartitionState> {
        let states = [
            PartitionState::Unassigned,
            PartitionState::Initialising,
            PartitionState::Active,
            PartitionState::Migrating,
            PartitionState::Decommissioning,
        ];
        states
            .into_iter()
            .find(|state| state.as_str() == text)
            .ok_or_else(|| {
                ClusterError::new(
                    codes::CONFIG_INVALID,
                    format!("Unknown partition state '{text}'"),
                )
                .with_detail("state", Value::String(text.to_string()))
                .with_detail(
                    "validStates",
                    Value::Array(
                        states
                            .iter()
                            .map(|state| Value::String(state.as_str().to_string()))
                            .collect(),
                    ),
                )
            })
    }
}

/// Which node holds each partition of one index, as the controller writes it.
#[derive(Debug, Clone, PartialEq)]
pub struct AllocationTable {
    /// The index that the table covers.
    pub index_name: String,
    /// The table's version, which a guarded write compares.
    pub version: f64,
    /// How many copies of each partition the index keeps.
    pub replication_factor: f64,
    /// Each partition id with its assignment, whose fields keep the names and the order that TypeScript gives them.
    pub assignments: Vec<(f64, Map)>,
    /// The generation of the index, where the table records one.
    pub generation: Option<String>,
    /// The UUID of the index, where the table records one.
    pub index_uuid: Option<String>,
}

/// The registration that a guarded allocation write requires a replica to hold, so that the controller assigns no
/// partition to a node that restarted since the controller read it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpectedReplicaRegistration {
    /// The replica's node id.
    pub node_id: String,
    /// The start time that the replica's registration must hold.
    pub started_at: String,
}

/// How long the lease under a node's registration holds without another renewal.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RegistrationLease {
    /// The milliseconds that remain, counted from when the coordinator sent the last renewal that etcd accepted.
    pub remaining_ms: f64,
    /// The lease's full lifetime, in milliseconds.
    pub ttl_ms: f64,
}

/// A change to the registered nodes.
#[derive(Debug, Clone, PartialEq)]
pub enum NodeEvent {
    /// A node registered, or changed its registration.
    Joined(NodeRegistration),
    /// A node's registration left etcd, with the node's id.
    Left(String),
}

/// A change to a stored schema.
#[derive(Debug, Clone, PartialEq)]
pub enum SchemaEvent {
    /// A schema was written for the named index.
    Created {
        /// The index.
        index_name: String,
        /// The schema, as stored.
        schema: Value,
    },
    /// The schema of the named index was dropped.
    Dropped {
        /// The index.
        index_name: String,
    },
}

/// A change to the metadata of one index, where `metadata` is absent after a delete or an empty write.
#[derive(Debug, Clone, PartialEq)]
pub struct IndexMetadataEvent {
    /// The index.
    pub index_name: String,
    /// The stored bytes.
    pub metadata: Option<Vec<u8>>,
}
