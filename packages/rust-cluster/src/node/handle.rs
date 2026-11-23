use std::sync::Arc;

use super::config::{ClusterNodeConfig, validate_config};
use super::member::{NodeInner, Phase, node_error};
use crate::controller::{Controller, lock};
use crate::error::{ClusterResult, codes};

/// A Rust node that joins a Narsil cluster with any of the `data`, `coordinator`, and `controller` roles, and takes
/// the steps that a TypeScript node of those roles takes.
///
/// A node with the `data` role keeps its copies in a local engine. As it joins, it adopts each copy that the cluster
/// claims, drops each copy of an index that the cluster replaced under the same name, and keeps any other copy as
/// orphaned. The node reports each orphaned copy, and it serves nothing from one.
///
/// A node with the `controller` role stands for the controller lease once it joins. While it holds the lease, it
/// places every index's partitions on the data nodes, answers the in-sync, bootstrap, and resignation messages that
/// a primary sends, applies a replication factor change and places the index again, drives a partition count change
/// to its cutover, runs the backup, restore, and backup deletion jobs, and refuses the query suggestion requests
/// with `CLUSTER_OPERATION_UNSUPPORTED`. A node on another major specification version than the active controller
/// cannot join.
pub struct ClusterNode {
    pub(super) inner: Arc<NodeInner>,
}

impl ClusterNode {
    /// Returns a node that has yet to join, from `config`.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` where the registration holds no role, an unknown role, an empty address, or an
    /// invalid node id, where `data` holds settings for a node without the `data` role or none for a node with it,
    /// where a timing value is zero, or where `in_flight_write_fraction` is not above 0 and at most 1.
    pub fn new(config: ClusterNodeConfig) -> ClusterResult<ClusterNode> {
        validate_config(&config)?;
        Ok(ClusterNode {
            inner: Arc::new(NodeInner::new(config)),
        })
    }

    /// Returns the node's id.
    pub fn node_id(&self) -> &str {
        self.inner.node_id()
    }

    /// Reports whether the node holds the controller lease.
    pub fn is_controller(&self) -> bool {
        self.inner
            .controller
            .as_ref()
            .is_some_and(Controller::is_active)
    }

    /// Joins the cluster, and returns once the node is registered and, for a node with the `controller` role, has
    /// stood for the controller lease once.
    ///
    /// The node opens its listener first, and answers `cluster.ping` from then on. Where etcd holds a live
    /// registration under the node's id, the node waits for that registration's lease to lapse before it writes a
    /// new one. A node with the `data` role then opens its local engine and settles each copy against the cluster's
    /// metadata before it registers. It renews its registration on every heartbeat interval until it shuts down. A
    /// failed join removes what the join wrote to etcd, closes the engine, and leaves the node free to start again.
    ///
    /// # Errors
    ///
    /// Fails with `NODE_VERSION_INCOMPATIBLE` before it writes anything where the active controller follows a
    /// specification version with another major version, with `NODE_ALREADY_JOINED` where the node is joining or
    /// has joined, with `NODE_NOT_JOINED` where the node shut down, and with the engine's, the coordinator's, or
    /// the transport's error where one of them fails.
    pub async fn start(&self) -> ClusterResult<()> {
        let _turn = self.inner.lifecycle.lock().await;
        let node_id = self.node_id();
        {
            let mut phase = lock(&self.inner.phase);
            match *phase {
                Phase::Idle => *phase = Phase::Joining,
                Phase::Shutdown => {
                    return Err(node_error(
                        codes::NODE_NOT_JOINED,
                        format!("Node '{node_id}' has been shut down and cannot rejoin"),
                        node_id,
                    ));
                }
                Phase::Joining | Phase::Active => {
                    return Err(node_error(
                        codes::NODE_ALREADY_JOINED,
                        format!("Node '{node_id}' has already joined the cluster"),
                        node_id,
                    ));
                }
            }
        }
        match self.inner.join().await {
            Ok(()) => {
                *lock(&self.inner.phase) = Phase::Active;
                Ok(())
            }
            Err(error) => {
                self.inner.leave().await;
                let mut phase = lock(&self.inner.phase);
                if *phase == Phase::Joining {
                    *phase = Phase::Idle;
                }
                Err(error)
            }
        }
    }

    /// Leaves the cluster for good: the node refuses new operations, waits for every operation that runs on it to
    /// return, gives up the controller lease where it holds it, stops renewing its registration, deregisters, stops
    /// listening, and closes the engine of its `data` role.
    ///
    /// A shutdown during a start ends the wait for an earlier registration, and the start then fails with
    /// `NODE_NOT_JOINED`. The coordinator and the transport stay open, because the caller owns them. A second
    /// call does nothing.
    pub async fn shutdown(&self) {
        self.inner.stopping.send_replace(true);
        self.inner.operations.drain().await;
        let _turn = self.inner.lifecycle.lock().await;
        let earlier = std::mem::replace(&mut *lock(&self.inner.phase), Phase::Shutdown);
        if earlier != Phase::Shutdown {
            self.inner.leave().await;
        }
    }
}
