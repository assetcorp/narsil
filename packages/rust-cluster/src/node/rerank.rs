use std::sync::Arc;

use narsil::RerankAdapter;

use super::handle::ClusterNode;
use crate::error::ClusterResult;

impl ClusterNode {
    /// Registers a rerank adapter on this node under a name that a search gives in `rerank.adapter`, replacing any
    /// adapter registered under it before.
    ///
    /// The node that receives a reranked search scores it with the adapter registered on that node, so register the
    /// adapter on every node that takes searches from clients. A data node that takes none needs none.
    ///
    /// # Errors
    ///
    /// Fails with `RERANK_CONFIG_INVALID` where `name` is empty once trimmed.
    pub fn register_rerank_adapter(
        &self,
        name: &str,
        adapter: Arc<dyn RerankAdapter>,
    ) -> ClusterResult<()> {
        Ok(self.inner.rerank.register(name, adapter)?)
    }

    /// Returns the most hits that one search through this node may rerank, as
    /// [`ClusterRerankConfig::max_window`](super::ClusterRerankConfig::max_window) sets it.
    pub fn max_rerank_window(&self) -> usize {
        self.inner.rerank.max_window()
    }
}
