use narsil::Map;

use super::handle::ClusterNode;
use super::member::{Phase, node_error};
use super::not_ready::not_ready;
use crate::controller::lock;
use crate::data::DataRole;
use crate::error::{ClusterResult, codes};

impl ClusterNode {
    fn joined_data_role(&self) -> ClusterResult<&DataRole> {
        let node_id = self.node_id();
        let Some(data) = &self.inner.data else {
            return Err(node_error(
                codes::CONFIG_INVALID,
                format!("Node '{node_id}' holds no data role, so it keeps no copy of any index"),
                node_id,
            ));
        };
        match *lock(&self.inner.phase) {
            Phase::Active => Ok(data),
            Phase::Idle | Phase::Joining => Err(not_ready(node_id)),
            Phase::Shutdown => Err(node_error(
                codes::NODE_NOT_JOINED,
                format!("Node '{node_id}' has been shut down"),
                node_id,
            )),
        }
    }

    /// Returns the document stored under `document_id` in this node's copy of `index_name`, vectors included, or
    /// `None` where the copy holds none.
    ///
    /// The answer comes from this node alone, so it can lag the partition's primary.
    ///
    /// # Errors
    ///
    /// Fails with `INDEX_ORPHANED` while the copy is orphaned, with `INDEX_NOT_FOUND` where the node holds no copy
    /// of the index, with `CONFIG_INVALID` on a node without the `data` role, with `NODE_NOT_READY` before the node
    /// has joined, and with `NODE_NOT_JOINED` after it shut down.
    pub async fn local_document(
        &self,
        index_name: &str,
        document_id: &str,
    ) -> ClusterResult<Option<Map>> {
        self.joined_data_role()?
            .document(index_name, document_id)
            .await
    }

    /// Deletes this node's orphaned copy of `index_name` and its stored data, after which the node answers for
    /// that name again.
    ///
    /// The call changes nothing in the cluster, so an index of the same name on other nodes keeps its documents.
    /// Absent metadata can follow from a coordinator restored from a backup, in which case the orphaned copy can be
    /// the only one left, so drop it only once you know that you don't need it.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` where the node holds no orphaned copy of that name or holds no `data` role, with
    /// `NODE_NOT_READY` before the node has joined, with `NODE_NOT_JOINED` after it shut down, and with the
    /// engine's error where it cannot delete the copy.
    pub async fn drop_orphaned_copy(&self, index_name: &str) -> ClusterResult<()> {
        self.joined_data_role()?
            .drop_orphaned_copy(index_name)
            .await
    }
}
