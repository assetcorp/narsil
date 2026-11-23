use narsil::{PreflightResult, QueryParams, QueryResult};

use super::handle::ClusterNode;
use crate::error::ClusterResult;
use crate::reads::{preflight_cluster, query_cluster, read_following_the_name};

fn left_out_a_partition(answer: &QueryResult) -> bool {
    answer.coverage.total_partitions == 0
        || answer.coverage.queried_partitions < answer.coverage.total_partitions
}

impl ClusterNode {
    /// Runs a search across a cluster index and returns the hits, ranked across every partition, with the
    /// partition coverage behind them.
    ///
    /// The search reads each partition from one active copy, and asks the next in-sync copy where that copy fails,
    /// times out, or cannot be reached. A partition counts as failed only once every copy of it has failed, so
    /// `coverage` tells an incomplete answer from a complete one. Hits under a `dfs` scoring mode score with the
    /// statistics of every partition, so their order matches one engine that holds every document. A node whose
    /// [`ClusterQueryConfig`](super::ClusterQueryConfig) sets `allow_partial_results` to false refuses an incomplete
    /// answer.
    ///
    /// # Errors
    ///
    /// Fails as [`ClusterNode::preflight`] does, with `QUERY_PARTIAL_FAILURE` where a partition went unread and
    /// this node refuses partial results, with `SEARCH_INVALID_CURSOR` for a cursor that another search produced,
    /// with `SEARCH_RESULT_WINDOW_EXCEEDED` where the offset and the limit reach past the first 10,000 results, with
    /// the code that a data node refuses an invalid query with, and with `RERANK_CONFIG_INVALID` for a query with a
    /// rerank step.
    pub async fn query(
        &self,
        index_name: &str,
        params: &QueryParams,
    ) -> ClusterResult<QueryResult> {
        let reads = self.inner.reads()?;
        self.track(
            Some(index_name),
            read_following_the_name(
                &reads,
                index_name,
                |serving| {
                    let reads = &reads;
                    async move { query_cluster(reads, &serving, params, index_name).await }
                },
                Some(left_out_a_partition),
            ),
        )
        .await
    }

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
        self.track(
            Some(index_name),
            read_following_the_name(
                &reads,
                index_name,
                |serving| {
                    let reads = &reads;
                    async move { preflight_cluster(reads, &serving, params, index_name).await }
                },
                None,
            ),
        )
        .await
    }
}
