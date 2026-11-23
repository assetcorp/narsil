use std::sync::Arc;

use narsil::{DocumentProjection, ListParams, Value};

use super::LocalAction;
use crate::constants::CLEAR_PAGE_SIZE;
use crate::controller::index_metadata;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::node::handle::ClusterNode;
use crate::reads::{ReadDeps, list_cluster, serving_name};

fn clear_page() -> ListParams {
    ListParams {
        limit: Some(CLEAR_PAGE_SIZE),
        document: Some(DocumentProjection::None),
        ..ListParams::default()
    }
}

fn not_allocated(index_name: &str) -> ClusterError {
    ClusterError::new(
        codes::QUERY_ROUTING_FAILED,
        format!(
            "The cluster owns index '{index_name}' and holds no allocation table for it yet, so this node cannot place a read or a write"
        ),
    )
    .with_detail("indexName", Value::from(index_name))
}

fn stalled(index_name: &str, remaining: u64, first: Option<(&str, &ClusterError)>) -> ClusterError {
    let mut error = ClusterError::new(
        codes::QUERY_ROUTING_FAILED,
        format!(
            "Clearing index '{index_name}' stalled: no document in the current page could be removed"
        ),
    )
    .with_detail("indexName", Value::from(index_name))
    .with_detail("remaining", Value::from(remaining));
    if let Some((document_id, failure)) = first {
        error = error
            .with_detail("firstFailureDocId", Value::from(document_id))
            .with_detail("firstFailureCode", Value::from(failure.code()))
            .with_detail("firstFailureMessage", Value::from(failure.message()));
    }
    error
}

impl ClusterNode {
    async fn clear_serving(
        &self,
        reads: &Arc<ReadDeps>,
        index_name: &str,
        serving: &str,
    ) -> ClusterResult<()> {
        let coordinator = self.inner.coordinator();
        let allocated = coordinator
            .allocation(serving)
            .await?
            .is_some_and(|table| !table.assignments.is_empty());
        if !allocated {
            if index_metadata(coordinator, serving).await?.is_none() {
                return self.act_locally(LocalAction::Clear, serving).await;
            }
            return Err(not_allocated(serving));
        }
        let page = clear_page();
        loop {
            let listed = list_cluster(reads, serving, &page, &[]).await?;
            if listed.documents.is_empty() {
                return Ok(());
            }
            let document_ids = listed
                .documents
                .into_iter()
                .map(|listed| listed.id)
                .collect();
            let removed = self.route_removals(index_name, document_ids).await?;
            if removed.succeeded.is_empty() {
                let first = removed
                    .failed
                    .first()
                    .map(|failure| (failure.document_id.as_str(), &failure.error));
                return Err(stalled(serving, listed.total, first));
            }
        }
    }

    /// Removes every document of a cluster index, one page of 1,000 documents at a time, through the primary of
    /// each document's partition, so that every copy removes them. An index that the cluster holds no metadata for
    /// is cleared in this node's local engine alone.
    ///
    /// # Errors
    ///
    /// Fails with `NODE_NOT_JOINED` before the node joins or once it shuts down, with `INDEX_ORPHANED` where this
    /// node keeps an orphaned copy under that name, with `CONFIG_INVALID` for a name that starts with
    /// `narsil-generation-`, with `QUERY_ROUTING_FAILED` where the cluster has yet to allocate the index or where
    /// no document of a page could be removed, and with the local engine's `INDEX_NOT_FOUND` where neither the
    /// cluster nor this node holds the index.
    pub async fn clear(&self, index_name: &str) -> ClusterResult<()> {
        let reads = self.inner.reads()?;
        self.track(Some(index_name), async {
            let serving = serving_name(&reads, index_name).await?;
            self.clear_serving(&reads, index_name, &serving).await
        })
        .await
    }
}
