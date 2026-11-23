use std::sync::atomic::Ordering;

use super::handle::ClusterNode;
use super::member::Phase;
use crate::controller::lock;

/// Whether a node can serve requests, as a readiness probe reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeReadiness {
    /// The node has yet to register with the cluster.
    Starting,
    /// The node is registered and is bringing into service a partition that the controller gave it.
    Joining,
    /// The node serves every partition that the controller gave it.
    Serving,
    /// The node is shutting down or has shut down.
    Leaving,
}

impl NodeReadiness {
    /// Returns the name that a TypeScript node reports for the same readiness.
    pub fn as_str(self) -> &'static str {
        match self {
            NodeReadiness::Starting => "STARTING",
            NodeReadiness::Joining => "JOINING",
            NodeReadiness::Serving => "SERVING",
            NodeReadiness::Leaving => "LEAVING",
        }
    }
}

/// What a node reports about itself: its id, its roles, and the step of its lifecycle that it is in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeInfo {
    /// The node's id.
    pub node_id: String,
    /// The roles that the node registered with.
    pub roles: Vec<String>,
    /// `stopped`, `joining`, `active`, or `shutdown`, the names that a TypeScript node reports.
    pub status: &'static str,
}

impl ClusterNode {
    /// Returns the node's id, its roles, and the step of its lifecycle that it is in.
    pub fn info(&self) -> NodeInfo {
        let status = match *lock(&self.inner.phase) {
            Phase::Idle => "stopped",
            Phase::Joining => "joining",
            Phase::Active => "active",
            Phase::Shutdown => "shutdown",
        };
        NodeInfo {
            node_id: self.node_id().to_string(),
            roles: self.inner.registration.roles.clone(),
            status,
        }
    }

    /// Returns whether the node can serve requests.
    ///
    /// The node reports [`NodeReadiness::Leaving`] once a shutdown begins, [`NodeReadiness::Starting`] until it
    /// registers, [`NodeReadiness::Joining`] while its join is unfinished or a partition that the controller gave it
    /// waits to come into service, and [`NodeReadiness::Serving`] otherwise.
    pub async fn readiness(&self) -> NodeReadiness {
        let phase = *lock(&self.inner.phase);
        if *self.inner.stopping.borrow() || phase == Phase::Shutdown {
            return NodeReadiness::Leaving;
        }
        if !self.inner.registered.load(Ordering::Acquire) {
            return NodeReadiness::Starting;
        }
        if phase != Phase::Active || !self.inner.joined.load(Ordering::Acquire) {
            return NodeReadiness::Joining;
        }
        let unserved = match &self.inner.data {
            Some(data) => data.unserved_partition_count().await,
            None => 0,
        };
        if unserved > 0 {
            NodeReadiness::Joining
        } else {
            NodeReadiness::Serving
        }
    }
}
