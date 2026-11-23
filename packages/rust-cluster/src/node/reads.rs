use std::collections::BTreeMap;

use narsil::{
    DocumentProjection, IndexInfo, ListParams, ListResult, Map, SortField, SuggestParams,
    SuggestResult,
};

use super::handle::ClusterNode;
use crate::error::ClusterResult;
use crate::reads::{
    ClusterIndexStats, ClusterPartitionStats, count_cluster, list_cluster, list_indexes_cluster,
    partition_stats_cluster, read_cluster_documents, read_following_the_name, stats_cluster,
    suggest_cluster,
};

const DOCUMENT_PRESENCE: DocumentProjection = DocumentProjection::None;

impl ClusterNode {
    /// Returns the document stored under `document_id` in a cluster index, or `None` where no copy holds one.
    ///
    /// The node reads the document from one active copy of its partition, and asks the next in-sync copy where
    /// that copy fails to answer. The document leaves out every vector field unless the index sets
    /// `returnVectors`.
    ///
    /// # Errors
    ///
    /// Fails with `NODE_NOT_JOINED` before the node joins, with `INDEX_ORPHANED` where this node keeps an orphaned
    /// copy under that name, with `INDEX_NOT_FOUND` where the cluster holds no such index, with
    /// `QUERY_ROUTING_FAILED` where the cluster has yet to allocate it, with `QUERY_NO_ACTIVE_REPLICA` where no
    /// active copy serves the document's partition or none answers, and with `QUERY_NODE_TIMEOUT` where the last
    /// copy that the node asked did not answer in time.
    pub async fn get(&self, index_name: &str, document_id: &str) -> ClusterResult<Option<Map>> {
        self.get_with(index_name, document_id, None).await
    }

    /// Returns the document stored under `document_id`, cut down to the fields that `projection` keeps, as
    /// [`narsil::Narsil::get_with`] cuts it.
    ///
    /// # Errors
    ///
    /// Fails as [`ClusterNode::get`] does.
    pub async fn get_with(
        &self,
        index_name: &str,
        document_id: &str,
        projection: Option<&DocumentProjection>,
    ) -> ClusterResult<Option<Map>> {
        let ids = [document_id.to_string()];
        let mut found = self.get_multiple_with(index_name, &ids, projection).await?;
        Ok(found.remove(document_id))
    }

    /// Returns the documents stored under each of `document_ids` that the cluster holds, keyed by id.
    ///
    /// # Errors
    ///
    /// Fails as [`ClusterNode::get`] does, where any document's partition fails.
    pub async fn get_multiple(
        &self,
        index_name: &str,
        document_ids: &[String],
    ) -> ClusterResult<BTreeMap<String, Map>> {
        self.get_multiple_with(index_name, document_ids, None).await
    }

    /// Returns the documents stored under each of `document_ids`, each cut down to the fields that `projection`
    /// keeps.
    ///
    /// # Errors
    ///
    /// Fails as [`ClusterNode::get`] does, where any document's partition fails.
    pub async fn get_multiple_with(
        &self,
        index_name: &str,
        document_ids: &[String],
        projection: Option<&DocumentProjection>,
    ) -> ClusterResult<BTreeMap<String, Map>> {
        let reads = self.inner.reads()?;
        self.track(
            Some(index_name),
            read_following_the_name(
                &reads,
                index_name,
                |serving| {
                    let reads = &reads;
                    async move {
                        read_cluster_documents(reads, &serving, document_ids, projection).await
                    }
                },
                None,
            ),
        )
        .await
    }

    /// Reports whether a cluster index holds a document under `document_id`.
    ///
    /// # Errors
    ///
    /// Fails as [`ClusterNode::get`] does.
    pub async fn has(&self, index_name: &str, document_id: &str) -> ClusterResult<bool> {
        Ok(self
            .get_with(index_name, document_id, Some(&DOCUMENT_PRESENCE))
            .await?
            .is_some())
    }

    /// Returns the number of documents in a cluster index, summed over one copy of each partition.
    ///
    /// # Errors
    ///
    /// Fails as [`ClusterNode::get`] does, and with `QUERY_PARTIAL_FAILURE` where no node answered for a
    /// partition, because a count with a partition missing is a wrong count.
    pub async fn count_documents(&self, index_name: &str) -> ClusterResult<u64> {
        let reads = self.inner.reads()?;
        self.track(
            Some(index_name),
            read_following_the_name(
                &reads,
                index_name,
                |serving| {
                    let reads = &reads;
                    async move { count_cluster(reads, &serving).await }
                },
                None,
            ),
        )
        .await
    }

    /// Returns the figures of a cluster index, read from one copy of each partition, with the saved and log sizes
    /// summed over every copy where every copy answers.
    ///
    /// # Errors
    ///
    /// Fails as [`ClusterNode::count_documents`] does.
    pub async fn get_stats(&self, index_name: &str) -> ClusterResult<ClusterIndexStats> {
        let reads = self.inner.reads()?;
        self.track(
            Some(index_name),
            read_following_the_name(
                &reads,
                index_name,
                |serving| {
                    let reads = &reads;
                    async move { stats_cluster(reads, &serving).await }
                },
                None,
            ),
        )
        .await
    }

    /// Returns the figures of each partition of a cluster index, in partition order.
    ///
    /// # Errors
    ///
    /// Fails as [`ClusterNode::count_documents`] does.
    pub async fn get_partition_stats(
        &self,
        index_name: &str,
    ) -> ClusterResult<Vec<ClusterPartitionStats>> {
        let reads = self.inner.reads()?;
        self.track(
            Some(index_name),
            read_following_the_name(
                &reads,
                index_name,
                |serving| {
                    let reads = &reads;
                    async move { partition_stats_cluster(reads, &serving).await }
                },
                None,
            ),
        )
        .await
    }

    /// Lists every index that the cluster holds a schema for, with its document count from the cluster and the
    /// residency of this node's copy, where it holds one.
    ///
    /// # Errors
    ///
    /// Fails with `NODE_NOT_JOINED` before the node joins, and with the first failure of an index's stats other
    /// than `INDEX_NOT_FOUND`, which leaves that index out.
    pub async fn list_indexes(&self) -> ClusterResult<Vec<IndexInfo>> {
        let reads = self.inner.reads()?;
        self.track(None, list_indexes_cluster(&reads)).await
    }

    /// Returns one page of a cluster index's stored documents in id order, merged from one copy of each
    /// partition, with the cursor that one engine hands out for the same page.
    ///
    /// # Errors
    ///
    /// Fails as [`ClusterNode::count_documents`] does, and with the errors of
    /// [`narsil::Narsil::list_documents`].
    pub async fn list_documents(
        &self,
        index_name: &str,
        params: &ListParams,
    ) -> ClusterResult<ListResult> {
        self.list_documents_sorted(index_name, params, &[]).await
    }

    /// Returns one page of a cluster index's stored documents in the order of `sort`, breaking each tie on
    /// document id, as [`narsil::Narsil::list_documents_sorted`] does.
    ///
    /// # Errors
    ///
    /// Fails as [`ClusterNode::list_documents`] does.
    pub async fn list_documents_sorted(
        &self,
        index_name: &str,
        params: &ListParams,
        sort: &[SortField],
    ) -> ClusterResult<ListResult> {
        let reads = self.inner.reads()?;
        self.track(
            Some(index_name),
            read_following_the_name(
                &reads,
                index_name,
                |serving| {
                    let reads = &reads;
                    async move { list_cluster(reads, &serving, params, sort).await }
                },
                None,
            ),
        )
        .await
    }

    /// Returns the completions of `params.prefix` across a cluster index, merged from one copy of each
    /// partition, the word that the most documents hold first.
    ///
    /// # Errors
    ///
    /// Fails as [`ClusterNode::count_documents`] does.
    pub async fn suggest(
        &self,
        index_name: &str,
        params: &SuggestParams,
    ) -> ClusterResult<SuggestResult> {
        let reads = self.inner.reads()?;
        self.track(
            Some(index_name),
            read_following_the_name(
                &reads,
                index_name,
                |serving| {
                    let reads = &reads;
                    async move { suggest_cluster(reads, &serving, params).await }
                },
                None,
            ),
        )
        .await
    }
}
