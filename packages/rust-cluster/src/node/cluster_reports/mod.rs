mod health;
mod metrics;
mod tables;
mod types;

pub use self::types::{
    ClusterHealth, ClusterMetrics, CommitPointFigure, HealthStatus, IndexHealth,
    PartitionReplicationFigure, ReplicaLagFigure,
};
use super::handle::ClusterNode;
use crate::constants::CONTROLLER_LEASE_KEY;
use crate::coordinator::NodeRegistration;
use crate::error::ClusterResult;

impl ClusterNode {
    /// Returns the registration of every node that etcd holds, as a TypeScript node lists them.
    ///
    /// # Errors
    ///
    /// Fails with `NODE_NOT_JOINED` once the node shuts down, and with the coordinator's error where etcd fails.
    pub async fn list_nodes(&self) -> ClusterResult<Vec<NodeRegistration>> {
        self.track(None, self.inner.coordinator().list_nodes())
            .await
    }

    /// Returns the id of the node that holds the controller lease, or `None` where no node holds it.
    ///
    /// # Errors
    ///
    /// Fails as [`ClusterNode::list_nodes`] does.
    pub async fn controller_node_id(&self) -> ClusterResult<Option<String>> {
        self.track(
            None,
            self.inner.coordinator().lease_holder(CONTROLLER_LEASE_KEY),
        )
        .await
    }

    /// Reports a green, yellow, or red status for the cluster and for each index that it serves, read from the
    /// allocation tables and the registrations that etcd holds.
    ///
    /// An index whose table holds no partition yet counts every partition that its metadata gives as one without
    /// a primary, so it reports red until the controller places it.
    ///
    /// # Errors
    ///
    /// Fails as [`ClusterNode::list_nodes`] does.
    pub async fn health(&self) -> ClusterResult<ClusterHealth> {
        self.track(None, health::read_cluster_health(self.inner.coordinator()))
            .await
    }

    /// Returns the replication figures of every partition that this node leads, the table's figures for every
    /// partition, and how long this node's calls to etcd took.
    ///
    /// # Errors
    ///
    /// Fails as [`ClusterNode::list_nodes`] does.
    pub async fn metrics(&self) -> ClusterResult<ClusterMetrics> {
        self.track(
            None,
            metrics::read_cluster_metrics(
                self.node_id(),
                self.inner.coordinator(),
                self.inner.data.as_ref(),
            ),
        )
        .await
    }
}
