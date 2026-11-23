mod bm25;
mod clear;
mod rebuild;
mod synonym_apply;
mod synonyms;

use narsil::{IndexInfo, MemoryStats, Narsil};

use super::handle::ClusterNode;
use crate::error::ClusterResult;
use crate::reads::serving_name;

/// The memory figures of this node's local engine, with the indexes that it holds, as `/stats/memory` reports them.
#[derive(Debug, Clone)]
pub struct LocalMemoryStats {
    /// The engine's memory figures.
    pub stats: MemoryStats,
    /// Each index that the local engine holds, with its residency.
    pub indexes: Vec<IndexInfo>,
}

#[derive(Debug, Clone, Copy)]
enum LocalAction {
    Checkpoint,
    Open,
    Close,
    Clear,
}

fn act_on_empty_engine(action: LocalAction, index_name: &str) -> ClusterResult<()> {
    let engine = Narsil::new();
    match action {
        LocalAction::Checkpoint => engine.checkpoint(index_name)?,
        LocalAction::Open => engine.open_index(index_name)?,
        LocalAction::Close => engine.close_index(index_name)?,
        LocalAction::Clear => engine.clear(index_name)?,
    }
    Ok(())
}

impl ClusterNode {
    async fn act_locally(&self, action: LocalAction, index_name: &str) -> ClusterResult<()> {
        let Some(data) = &self.inner.data else {
            return act_on_empty_engine(action, index_name);
        };
        match action {
            LocalAction::Checkpoint => data.checkpoint_local(index_name).await,
            LocalAction::Open => data.open_local(index_name).await,
            LocalAction::Close => data.close_local(index_name).await,
            LocalAction::Clear => data.clear_local(index_name).await,
        }
    }

    async fn act_on_serving_copy(
        &self,
        action: LocalAction,
        index_name: &str,
    ) -> ClusterResult<()> {
        let reads = self.inner.reads()?;
        let serving = serving_name(&reads, index_name).await?;
        self.act_locally(action, &serving).await
    }

    /// Returns the memory figures of this node's local engine and the indexes that it holds. A node without the
    /// `data` role reports the figures of an engine that holds no index, as a TypeScript node does.
    ///
    /// # Errors
    ///
    /// Fails with `NODE_NOT_JOINED` once the node shuts down, and with `NODE_NOT_READY` where a data node has yet
    /// to open its engine.
    pub async fn local_memory_stats(&self) -> ClusterResult<LocalMemoryStats> {
        self.track(None, async {
            let (stats, indexes) = match &self.inner.data {
                Some(data) => data.local_memory().await?,
                None => {
                    let engine = Narsil::new();
                    (engine.get_memory_stats(), engine.list_indexes())
                }
            };
            Ok(LocalMemoryStats { stats, indexes })
        })
        .await
    }

    /// Writes this node's copy of an index to its durability store, under the name that the index serves from. A
    /// node without the `data` role answers as an engine that holds no index does.
    ///
    /// # Errors
    ///
    /// Fails with `NODE_NOT_JOINED` before the node joins, with `INDEX_ORPHANED` where this node keeps an orphaned
    /// copy under that name, with `CONFIG_INVALID` for a name that starts with `narsil-generation-`, and with the
    /// local engine's error, such as `INDEX_NOT_FOUND` where this node holds no copy.
    pub async fn checkpoint(&self, index_name: &str) -> ClusterResult<()> {
        self.track(
            Some(index_name),
            self.act_on_serving_copy(LocalAction::Checkpoint, index_name),
        )
        .await
    }

    /// Opens this node's copy of an index from its files, under the name that the index serves from.
    ///
    /// # Errors
    ///
    /// Fails as [`ClusterNode::checkpoint`] does.
    pub async fn open_index(&self, index_name: &str) -> ClusterResult<()> {
        self.track(
            Some(index_name),
            self.act_on_serving_copy(LocalAction::Open, index_name),
        )
        .await
    }

    /// Closes this node's copy of an index, once every call that is under way on the index ends, and forgets the
    /// replication state that this node keeps for it.
    ///
    /// # Errors
    ///
    /// Fails as [`ClusterNode::checkpoint`] does.
    pub async fn close_index(&self, index_name: &str) -> ClusterResult<()> {
        self.transition_index(
            index_name,
            self.act_on_serving_copy(LocalAction::Close, index_name),
        )
        .await
    }
}
