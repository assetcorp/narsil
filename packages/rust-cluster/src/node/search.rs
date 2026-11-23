use narsil::{PreflightResult, QueryParams};

use super::handle::ClusterNode;
use crate::error::ClusterResult;
use crate::reads::{preflight_cluster, read_following_the_name};

impl ClusterNode {
    /// Returns how many documents of a cluster index `params` matches, summed over one copy of each partition,
    /// without building a page of hits.
    ///
    /// The count is exact unless `params` carries a vector clause with a term, a hybrid mode, or a similarity
    /// floor, where `count_exact` is false.
    ///
    /// # Errors
    ///
    /// Fails as [`ClusterNode::count_documents`] does, with `SEARCH_INVALID_FIELD` for BM25 parameters that name no
    /// text field of the schema, with `BM25_NOT_READY` where the query sets BM25 parameters or the index has tuned
    /// them and a node that holds a copy speaks a specification version below 1.1, and with
    /// `SEARCH_PHRASE_NOT_READY` where the term quotes a phrase and such a node holds a copy.
    pub async fn preflight(
        &self,
        index_name: &str,
        params: &QueryParams,
    ) -> ClusterResult<PreflightResult> {
        let reads = self.inner.reads()?;
        read_following_the_name(
            &reads,
            index_name,
            |serving| {
                let reads = &reads;
                async move { preflight_cluster(reads, &serving, params, index_name).await }
            },
            None,
        )
        .await
    }
}
