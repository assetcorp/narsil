use narsil_cluster::node::CreateIndexOptions;

/// How a server that fronts a cluster node shapes the operations that it forwards to the node.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ClusterOptions {
    /// The partition count, the replication factor, and the serving wait of every index that the server creates,
    /// where each one left unset takes the cluster's default.
    pub create_index: CreateIndexOptions,
}
