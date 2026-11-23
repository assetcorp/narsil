use crate::coordinator::etcd::CoordinatorRequestFigure;

/// The health of the cluster or of one index, from best to worst.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum HealthStatus {
    /// Every partition has a live primary and as many live in-sync replicas as the replication factor asks for.
    Green,
    /// Every partition has a live primary, and at least one partition is short of in-sync replicas or is not
    /// active.
    Yellow,
    /// At least one partition has no live primary.
    Red,
}

impl HealthStatus {
    /// Returns the name that a TypeScript node reports for the same status.
    pub fn as_str(self) -> &'static str {
        match self {
            HealthStatus::Green => "green",
            HealthStatus::Yellow => "yellow",
            HealthStatus::Red => "red",
        }
    }
}

/// The health of one index, as `/cluster/health` reports it.
#[derive(Debug, Clone, PartialEq)]
pub struct IndexHealth {
    /// The name that callers reach the index by.
    pub index_name: String,
    /// The worst status that any partition of the index gives.
    pub status: HealthStatus,
    /// The number of partitions of the index.
    pub partition_count: f64,
    /// How many copies of each partition the index keeps.
    pub replication_factor: f64,
    /// The partitions with no primary, or whose primary holds no registration.
    pub partitions_without_primary: u64,
    /// The partitions that are not active, or that have fewer live in-sync replicas than the replication factor.
    pub under_replicated_partitions: u64,
}

/// The health of the cluster: the worst status of any index, and the health of each index in name order.
#[derive(Debug, Clone, PartialEq)]
pub struct ClusterHealth {
    /// The worst status of any index, or green where the cluster holds no index.
    pub status: HealthStatus,
    /// Each index the cluster serves, in name order.
    pub indexes: Vec<IndexHealth>,
}

/// How far one replica of a partition that this node leads trails this node's log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplicaLagFigure {
    /// The name that callers reach the index by.
    pub index_name: String,
    /// The partition.
    pub partition_id: u32,
    /// The node that holds the replica.
    pub replica: String,
    /// The entries that the replica has yet to acknowledge.
    pub lag: u64,
}

/// The commit point of one partition that this node leads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitPointFigure {
    /// The name that callers reach the index by.
    pub index_name: String,
    /// The partition.
    pub partition_id: u32,
    /// The highest sequence number that this node acknowledged to a client.
    pub commit_point: u64,
}

/// What the allocation table records about the replication of one partition.
#[derive(Debug, Clone, PartialEq)]
pub struct PartitionReplicationFigure {
    /// The name that callers reach the index by.
    pub index_name: String,
    /// The partition.
    pub partition_id: u32,
    /// The floor on the commit point that the table stores.
    pub commit_point_floor: f64,
    /// The replicas besides the primary that are in the partition's in-sync set.
    pub in_sync_replicas: u64,
}

/// The replication and coordinator figures that `/metrics` reports for this node.
#[derive(Debug, Clone, PartialEq)]
pub struct ClusterMetrics {
    /// The lag of each replica of each partition that this node leads.
    pub replication_lag: Vec<ReplicaLagFigure>,
    /// The commit point of each partition that this node leads.
    pub commit_points: Vec<CommitPointFigure>,
    /// The table's figures for every partition of every index.
    pub partitions: Vec<PartitionReplicationFigure>,
    /// How long this node's calls to etcd took, one histogram for each operation.
    pub coordinator_requests: Vec<CoordinatorRequestFigure>,
}
